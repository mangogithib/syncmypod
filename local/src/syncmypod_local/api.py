"""Client for the SyncMyPod server's device API.

This is the other half of the contract written down in the server repository's
``docs/LOCAL_APP_API.md``. Everything here is authenticated by the device bearer
token; there is no session, no cookie, and no password.

The server never sends audio and never will - it holds library data only. What
comes back from ``manifest()`` is a description of what *should* be on the iPod,
and finding the audio is this application's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from . import __version__

# The manifest shapes this client understands. The server states its own version
# in every manifest; refusing an unknown one is deliberate, because
# misinterpreting a field is worse than stopping with a clear message.
SUPPORTED_MANIFEST_VERSIONS = frozenset({1})

USER_AGENT = f"SyncMyPod-Local/{__version__}"


class ApiError(Exception):
    """A request that failed in a way worth showing the user."""

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class NotPairedError(ApiError):
    """The token is missing, revoked, or belongs to a deleted device."""


class UnsupportedServerError(ApiError):
    """The server speaks a manifest version this build does not understand."""


@dataclass(slots=True)
class Pairing:
    """What the server hands back when a pairing code is redeemed."""

    token: str
    device_id: int
    device_name: str
    server_url: str


def claim_pairing_code(server_url: str, code: str, device_name: str, platform: str) -> Pairing:
    """Trade a short pairing code for a long-lived device token.

    Deliberately a module-level function rather than a method: it is the one
    call that happens *before* there is a token, so it cannot belong to a client
    that requires one.
    """
    url = _join(server_url, "/api/devices/claim")
    payload = {
        "code": code.strip().upper().replace(" ", "").replace("-", ""),
        "deviceName": device_name,
        "platform": platform,
        "appVersion": __version__,
    }

    try:
        with httpx.Client(timeout=20.0, headers={"User-Agent": USER_AGENT}) as client:
            response = client.post(url, json=payload)
    except httpx.HTTPError as err:
        raise ApiError(
            f"Could not reach {server_url}: {err}. Check the address and that the server is running."
        ) from err

    body = _decode(response)
    if response.status_code != 200:
        raise ApiError(
            body.get("error") or f"Pairing failed ({response.status_code}).",
            status=response.status_code,
        )

    device = body.get("device") or {}
    return Pairing(
        token=str(body["token"]),
        device_id=int(device.get("id", 0)),
        device_name=str(device.get("name") or device_name),
        # The server's own canonical address, which may differ from what the
        # user typed - a trailing slash, http where it should be https, or an
        # IP where a hostname is configured. Storing the server's answer avoids
        # a pairing that works once and then cannot find its way back.
        server_url=str(body.get("serverUrl") or server_url).rstrip("/"),
    )


class DeviceApi:
    """Authenticated calls. One instance per sync run."""

    def __init__(self, server_url: str, token: str, *, timeout: float = 30.0):
        self._client = httpx.Client(
            base_url=server_url.rstrip("/"),
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
            # A manifest for a large library is worth compressing over a home
            # connection.
            follow_redirects=False,
        )

    def __enter__(self) -> DeviceApi:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # -- calls --------------------------------------------------------------

    def hello(self) -> dict[str, Any]:
        """Confirm the token and that the server speaks a manifest we know.

        Called first, every run. A revoked token surfaces here as a clean
        "pair again" rather than as a confusing failure halfway through a sync.
        """
        body = self._get("/api/sync/hello")

        supported = set(body.get("supportedManifestVersions") or [body.get("manifestVersion")])
        if not supported & SUPPORTED_MANIFEST_VERSIONS:
            raise UnsupportedServerError(
                f"This server speaks manifest version(s) {sorted(supported)}, "
                f"and this app understands {sorted(SUPPORTED_MANIFEST_VERSIONS)}. "
                "Update the local app."
            )
        return body

    def report_device(self, details: dict[str, Any]) -> None:
        """Tell the server what iPod is attached.

        Every field is optional server-side, so anything undetected is simply
        omitted rather than guessed at.
        """
        self._post("/api/sync/device", {k: v for k, v in details.items() if v is not None})

    def manifest(self) -> dict[str, Any]:
        """Everything that should be on this iPod."""
        body = self._get("/api/sync/manifest")

        version = body.get("manifestVersion")
        if version not in SUPPORTED_MANIFEST_VERSIONS:
            raise UnsupportedServerError(
                f"Manifest version {version} is not supported by this build. Update the local app."
            )
        return body

    def device_state(self) -> dict[str, Any]:
        """What the server believes is already on this device."""
        return self._get("/api/sync/state")

    def start_run(self, *, planned: int, to_download: int, to_remove: int) -> int:
        body = self._post(
            "/api/sync/runs",
            {"planned": planned, "toDownload": to_download, "toRemove": to_remove},
        )
        return int(body["id"])

    def report_results(self, run_id: int, results: list[dict[str, Any]]) -> dict[str, Any]:
        """Report outcomes for a batch of tracks.

        Called repeatedly during a run rather than once at the end. A sync
        interrupted halfway still records what landed, so the next run does not
        download those tracks again.
        """
        if not results:
            return {"recorded": 0}
        # The server caps a batch at 500.
        return self._post(f"/api/sync/runs/{run_id}/results", {"results": results[:500]})

    def finish_run(
        self,
        run_id: int,
        *,
        status: str = "done",
        stats: dict[str, Any] | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"status": status, "stats": stats or {}}
        if message:
            payload["message"] = message
        return self._post(f"/api/sync/runs/{run_id}/finish", payload)

    # -- plumbing -----------------------------------------------------------

    # --- the YouTube library ------------------------------------------------
    #
    # Reading the account's playlists happens here rather than on the server,
    # because the YouTube session is here. The server gets names and video ids;
    # it never gets a credential.

    def push_youtube_library(self, playlists: list[dict[str, Any]]) -> dict[str, Any]:
        """Send the list of playlists, and learn which ones are wanted.

        One call does both so a routine sync is a single round trip before any
        contents are read.
        """
        return self._post("/api/sync/youtube/library", {"playlists": playlists})

    def selected_youtube_playlists(self) -> list[dict[str, Any]]:
        """The playlists the user ticked in the web interface."""
        return list(self._get("/api/sync/youtube/selected").get("playlists") or [])

    def push_youtube_playlist(
        self, youtube_id: str, entries: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Send one playlist's contents for the server to resolve and import."""
        return self._post(
            "/api/sync/youtube/playlist",
            {"youtubeId": youtube_id, "entries": entries},
        )

    def _get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, payload)

    def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            response = self._client.request(method, path, json=payload)
        except httpx.HTTPError as err:
            raise ApiError(f"{method} {path} failed: {err}", retryable=True) from err

        body = _decode(response)

        if response.status_code == 401:
            raise NotPairedError(
                body.get("error")
                or "This device is no longer authorised. Pair it again from the web interface.",
                status=401,
            )
        if response.status_code == 429:
            raise ApiError(
                body.get("error") or "The server is rate limiting this device.",
                status=429,
                retryable=True,
            )
        if response.status_code >= 500:
            raise ApiError(
                body.get("error") or f"Server error ({response.status_code}).",
                status=response.status_code,
                retryable=True,
            )
        if response.status_code >= 400:
            raise ApiError(
                body.get("error") or f"Request rejected ({response.status_code}).",
                status=response.status_code,
            )
        return body


def _decode(response: httpx.Response) -> dict[str, Any]:
    """Best-effort JSON.

    A non-JSON body from this API means something upstream intervened - a proxy
    error page, usually. Returning the text under an ``error`` key keeps that
    visible instead of collapsing it into a parse failure that says nothing.
    """
    if not response.content:
        return {}
    try:
        decoded = response.json()
    except ValueError:
        return {"error": response.text[:300].strip()}
    return decoded if isinstance(decoded, dict) else {"data": decoded}


def _join(base: str, path: str) -> str:
    return f"{base.rstrip('/')}{path}"
