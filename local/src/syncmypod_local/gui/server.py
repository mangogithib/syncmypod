"""The local HTTP server behind the GUI.

Built on the standard library so the GUI costs nothing in dependencies or in
packaged size. It serves a handful of static files and a small JSON API, and
runs one sync at a time on a worker thread so the page stays responsive while a
run is going.

On security, since this is a server listening on a machine that also browses the
web. It binds to 127.0.0.1, so nothing off the machine can reach it at all. A
random token is generated at startup and required on every request, which stops
a web page you happen to have open from driving your iPod - the browser will
happily let a page make requests to localhost, and the token is what it cannot
guess. The Host header is checked as well, because a hostile DNS record pointing
at 127.0.0.1 would otherwise let a page treat this as its own origin.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import secrets
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .. import config as config_module
from .. import device as device_module
from .. import ffmpeg as ffmpeg_finder
from .. import sync as sync_engine
from .. import youtube as youtube_module
from ..api import ApiError, claim_pairing_code

logger = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
COOKIE_NAME = "syncmypod_gui"

# Events are kept so a page that was opened late, or reloaded mid-run, can
# catch up rather than showing an empty log next to a running sync.
_MAX_EVENTS = 2000


@dataclass
class Session:
    """Everything one GUI process knows, shared between request threads."""

    token: str
    events: list[dict[str, Any]] = field(default_factory=list)
    running: bool = False
    cancelled: bool = False
    summary: dict[str, Any] | None = None
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, kind: str, **data: Any) -> None:
        with self.lock:
            self.events.append({"seq": len(self.events), "kind": kind, **data})
            if len(self.events) > _MAX_EVENTS:
                del self.events[: len(self.events) - _MAX_EVENTS]

    def since(self, seq: int) -> list[dict[str, Any]]:
        with self.lock:
            return [event for event in self.events if event["seq"] >= seq]

    def reset(self) -> None:
        with self.lock:
            self.events.clear()
            self.summary = None
            self.error = None
            self.cancelled = False


class GuiServer:
    """Owns the HTTP server, the session, and the one sync thread."""

    def __init__(self, *, host: str = "127.0.0.1", port: int = 0):
        self.session = Session(token=secrets.token_urlsafe(24))
        self._worker: threading.Thread | None = None
        # When the page last said anything.
        #
        # This is how the application knows its window has gone. Waiting on the
        # browser process instead does not work: a Chromium launcher hands the
        # request to a session process and exits, so the wait returns while the
        # window is still on screen - and 0.1.9 then shut the server down under
        # it, which is the connection refused page in a window with no tabs.
        #
        # The page pings while it is open. No pings means no page.
        self._last_seen = time.monotonic()
        # Port 0 asks the operating system for a free one, so two copies of the
        # application never collide and no fixed port has to be reserved.
        self._httpd = ThreadingHTTPServer((host, port), _make_handler(self))
        self._httpd.daemon_threads = True

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/?t={self.session.token}"

    @property
    def address(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"{host}:{port}"

    def serve_forever(self) -> None:
        self._httpd.serve_forever()

    def touch(self) -> None:
        """Called on every request from the page."""
        self._last_seen = time.monotonic()

    @property
    def idle_for(self) -> float:
        """Seconds since the page last said anything."""
        return time.monotonic() - self._last_seen

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    # -- actions the page can ask for ---------------------------------------

    def state(self, user_agent: str = "") -> dict[str, Any]:
        """What to show before anything has been asked for.

        Every part is optional and failures are reported rather than raised: a
        server that is down, an iPod that is unplugged and a missing ffmpeg are
        three separate problems, and the page should show which one applies
        rather than one blanket error.
        """
        stored = config_module.load()
        found = ffmpeg_finder.find()

        payload: dict[str, Any] = {
            "paired": stored.is_paired,
            "server": stored.server_url,
            "deviceName": stored.device_name,
            "ffmpeg": {"found": found is not None, "detail": ffmpeg_finder.describe()},
            # Which audio the user has asked for. Read from the stored config
            # rather than held in the page, so it survives a reload and agrees
            # with what a sync started from the terminal would do.
            "audioQuality": stored.audio_quality,
            # Whether a session is saved, and what it was last found to be
            # worth. Not re-probed here: asking YouTube costs a request and a
            # couple of seconds, and this runs on every page load. The stored
            # verdict is what decides whether the Premium option can be chosen,
            # so it has to travel with the state rather than being asked for.
            #
            # Which browser it came from is not the page's business: signing in
            # tries them all, and the browser viewing this page is used to order
            # the attempts server-side rather than to fill in a menu.
            "youtube": {
                "signedIn": youtube_module.is_signed_in(),
                "premium": bool(stored.youtube_premium),
                "checked": stored.youtube_checked_at is not None,
            },
            "running": self.session.running,
            "backupBeforeSync": stored.backup_before_sync,
            "ipod": None,
            "ipodError": None,
        }

        try:
            attached = device_module.scan()
        except device_module.DeviceError as err:
            payload["ipodError"] = str(err)
            return payload

        if attached:
            ipod = attached[0]
            payload["ipod"] = {
                "name": ipod.name,
                "model": ipod.model,
                "generation": ipod.generation,
                "mount": str(ipod.mount_path),
                "capacityBytes": ipod.capacity_bytes,
                "freeBytes": ipod.free_bytes,
                "needsSignature": ipod.needs_signature,
                "checksumType": ipod.checksum_type,
            }
        return payload

    def start(
        self,
        *,
        dry_run: bool,
        remove: bool,
        limit: int | None,
        backup: bool | None = None,
    ) -> dict[str, Any]:
        """Begin a run on a worker thread, or refuse if one is already going."""
        if self.session.running:
            return {"started": False, "error": "A sync is already running."}

        # Remembered rather than applied to this run alone. The page shows it as
        # a setting, so it has to still be off the next time the page is opened.
        if backup is not None:
            self.save_settings({"backupBeforeSync": backup})

        self.session.reset()
        self.session.running = True
        self._worker = threading.Thread(
            target=self._run,
            kwargs={
                "dry_run": dry_run,
                "remove": remove,
                "limit": limit,
                "backup": backup,
            },
            daemon=True,
        )
        self._worker.start()
        return {"started": True}

    def start_match_check(self) -> dict[str, Any]:
        """Search for every unlinked track, downloading nothing.

        Shares the session and the progress channel with a sync because it is
        the same question asked without the iPod: which of these can be found.
        Refused while a sync is running - both drive the same search and would
        be two machines' worth of requests from one address.
        """
        if self.session.running:
            return {"started": False, "error": "Something is already running."}

        self.session.reset()
        self.session.running = True
        self._worker = threading.Thread(target=self._run_match_check, daemon=True)
        self._worker.start()
        return {"started": True}

    def _run_match_check(self) -> None:
        try:
            report = sync_engine.check_matches(
                config_module.load(),
                progress=self._progress,
                cancel=lambda: self.session.cancelled,
            )
            self.session.summary = {
                "kind": "matches",
                "status": report.status,
                "checked": report.checked,
                "found": report.found,
                "missing": [{"label": label} for label, _reason in report.missing],
                "skipped": report.skipped,
                "message": report.message,
            }
            self.session.add("done", summary=self.session.summary)
        except (
            sync_engine.SyncError,
            ApiError,
            config_module.ConfigError,
        ) as err:
            self.session.error = str(err)
            self.session.add("error", message=str(err))
        except Exception as err:  # pragma: no cover - a bug, not a user problem
            logger.exception("The match check failed unexpectedly")
            self.session.error = f"Unexpected failure: {err}"
            self.session.add("error", message=self.session.error)
        finally:
            self.session.running = False

    def pair(self, server_url: str, code: str, device_name: str) -> dict[str, Any]:
        """Exchange a pairing code for a device token, from the page.

        This was a terminal-only command, which meant the application could not
        be used at all without one. Pairing is a once-per-computer job, but it
        is also the very first thing anybody does, and "open a terminal" is a
        poor first instruction.

        The account password is still never involved: a code is traded for a
        token, exactly as the CLI does it.
        """
        import platform as platform_module

        address = str(server_url or "").strip()
        pairing_code = str(code or "").strip()
        if not address:
            return {"paired": False, "error": "Enter the address of your library server."}
        if not pairing_code:
            return {"paired": False, "error": "Enter the pairing code from the web interface."}

        # A bare hostname is what people type. Without a scheme the request
        # would fail with something about a missing protocol, which is a poor
        # way to say "add https://".
        if not address.startswith(("http://", "https://")):
            address = f"https://{address}"

        name = str(device_name or "").strip() or platform_module.node() or "This computer"

        try:
            pairing = claim_pairing_code(
                address, pairing_code, name, platform_module.system().lower()
            )
        except ApiError as err:
            return {"paired": False, "error": str(err)}

        config_module.save(
            config_module.Config(
                server_url=pairing.server_url,
                token=pairing.token,
                device_name=pairing.device_name,
            )
        )
        return {"paired": True, "server": pairing.server_url, "deviceName": pairing.device_name}

    def unpair(self) -> dict[str, Any]:
        """Forget the pairing on this computer only."""
        return {"unpaired": config_module.clear()}

    def save_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Store whichever preferences the page sent.

        Only the keys present are touched. The page sends one at a time, and a
        handler that wrote every field from the payload would reset the backup
        toggle every time somebody picked an audio quality.

        Saved the moment they change rather than when a sync starts, so a
        setting means what it looks like it means if the window is closed in
        between.
        """
        stored = config_module.load()
        changed = False

        if "backupBeforeSync" in payload:
            enabled = bool(payload.get("backupBeforeSync"))
            if stored.backup_before_sync != enabled:
                stored.backup_before_sync = enabled
                changed = True
                logger.info("Backup before sync is now %s", "on" if enabled else "off")

        if "audioQuality" in payload:
            quality = config_module.normalise_quality(payload.get("audioQuality"))
            if stored.audio_quality != quality:
                stored.audio_quality = quality
                changed = True
                logger.info("Audio quality is now %s", quality)

        if changed:
            config_module.save(stored)
        return {
            "backupBeforeSync": stored.backup_before_sync,
            "audioQuality": stored.audio_quality,
        }

    def youtube_check(self) -> dict[str, Any]:
        """Ask YouTube what bitrate this session is offered.

        The answer is written to the config by `youtube.check` itself, so the
        Premium option stays unlocked - or locked - across a restart without
        the page having to ask again.
        """
        available = youtube_module.check()
        return {
            "signedIn": available.signed_in,
            "premium": available.premium,
            "bestAacKbps": available.best_aac_kbps,
            "detail": available.describe(),
            "error": available.error,
        }

    def youtube_sign_in(self, browser: str = "", user_agent: str = "") -> dict[str, Any]:
        """Get a YouTube session, by whichever of the two routes works.

        **Reading an installed browser first**, because when it works it is
        instantaneous and nothing appears on screen. That is the Firefox case,
        and on a machine with Firefox it is still the right answer.

        **Opening a browser of our own second**, because on Windows the first
        route is now usually impossible: Chromium seals its cookie values and
        no other program can decrypt them. A window this application started
        can simply be asked for its cookies instead.

        Falling through rather than asking which to use: the difference between
        them is an implementation detail of somebody else's browser, and nobody
        should have to learn it to play music on an iPod.
        """
        try:
            available = youtube_module.sign_in(
                browser or None,
                prefer=youtube_module.browser_from_user_agent(user_agent),
            )
            return self._youtube_result(available, opened_a_window=False)
        except youtube_module.YouTubeError as err:
            # Bound to a name that outlives the block: Python unbinds an
            # `except ... as` target the moment the handler ends.
            read_failure = str(err)
            logger.info("Could not read an installed browser: %s", read_failure)

        if browser:
            # A named browser is a specific instruction, not a request for a
            # session by any means available.
            return {"saved": False, "error": read_failure}

        try:
            available = youtube_module.sign_in_with_browser()
        except youtube_module.YouTubeError as err:
            return {"saved": False, "error": str(err)}
        return self._youtube_result(available, opened_a_window=True)

    @staticmethod
    def _youtube_result(available: Any, *, opened_a_window: bool) -> dict[str, Any]:
        return {
            "saved": True,
            "signedIn": True,
            "premium": available.premium,
            "bestAacKbps": available.best_aac_kbps,
            "detail": available.describe(),
            "error": available.error,
            "openedAWindow": opened_a_window,
        }

    def youtube_use_cookies(self, path: str = "") -> dict[str, Any]:
        """Use a cookies.txt the user exported, rather than reading a browser.

        The only route left on a Windows machine with no Firefox: Chromium seals
        its cookies there, so the browser has to do the decrypting and hand over
        the result.
        """
        if not path.strip():
            return {"saved": False, "error": "Give the path to a cookies.txt file."}
        try:
            available = youtube_module.import_cookies_file(path)
        except youtube_module.YouTubeError as err:
            return {"saved": False, "error": str(err)}
        return self._youtube_result(available, opened_a_window=False)

    def youtube_sign_out(self) -> dict[str, Any]:
        return {"signedOut": youtube_module.forget()}

    def eject(self, mount: str = "") -> dict[str, Any]:
        """Flush the iPod and unmount it, so it is safe to pull out.

        The other half of Cancel. Stopping a sync tidies the database up, but a
        freshly written one can still be sitting in the operating system's write
        cache - and the moment after a sync is exactly when somebody in a hurry
        pulls the cable. Asking for the iPod back should not mean guessing when
        Windows has finished with it.

        Refused while a sync is running: the run is still writing.
        """
        if self.session.running:
            return {
                "ejected": False,
                "error": "A sync is still running. Press Cancel first, then eject.",
            }
        try:
            ipod = (
                device_module.open_at(mount)
                if mount
                else next(iter(device_module.scan()), None)
            )
            if ipod is None:
                return {"ejected": False, "error": "No iPod is connected."}
            ok, message = ipod.eject()
        except device_module.DeviceError as err:
            return {"ejected": False, "error": str(err)}
        return {"ejected": ok, "message": message, "error": None if ok else message}

    def cancel(self) -> dict[str, Any]:
        """Ask the run to stop at the next track boundary.

        Deliberately not an abort. Stopping between tracks means the database is
        never interrupted mid-write, and what has already been copied stays
        usable.
        """
        self.session.cancelled = True
        self.session.add("cancelling")
        return {"cancelling": True}

    def _run(
        self, *, dry_run: bool, remove: bool, limit: int | None, backup: bool | None = None
    ) -> None:
        try:
            report = sync_engine.run(
                config_module.load(),
                dry_run=dry_run,
                remove=remove,
                limit=limit,
                backup=backup,
                progress=self._progress,
                cancel=lambda: self.session.cancelled,
            )
            self.session.summary = _summarise(report, dry_run=dry_run)
            self.session.add("done", summary=self.session.summary)
        except (
            sync_engine.SyncError,
            device_module.DeviceError,
            ApiError,
            ffmpeg_finder.FfmpegMissing,
            config_module.ConfigError,
        ) as err:
            self.session.error = str(err)
            self.session.add("error", message=str(err))
        except Exception as err:  # pragma: no cover - a bug, not a user problem
            logger.exception("The sync failed unexpectedly")
            self.session.error = f"Unexpected failure: {err}"
            self.session.add("error", message=self.session.error)
        finally:
            self.session.running = False

    def _progress(self, event: str, data: dict[str, Any]) -> None:
        """Translate the engine's events into something the page can render.

        The engine hands over its own objects; only the fields the page uses are
        put on the wire, so a change to an internal dataclass does not silently
        become part of the GUI's contract.
        """
        if event == "device":
            ipod = data["device"]
            self.session.add(
                "device",
                label=ipod.describe(),
                mount=str(ipod.mount_path),
                freeBytes=ipod.free_bytes,
            )
        elif event == "plan":
            plan = data["plan"]
            self.session.add(
                "plan",
                toDownload=len(plan.to_download),
                alreadyPresent=len(plan.already_present),
                adopted=len(plan.adopted),
                removals=[{"id": r.track_id, "label": r.label} for r in plan.removals],
                playlists=len(plan.playlists),
                artworkMissing=len(plan.artwork_missing),
                excluded=len(plan.excluded),
                tracks=[{"id": t.id, "label": t.label} for t in plan.to_download],
            )
        elif event == "database":
            self.session.add("database")
        elif event in {"backup", "backup-skipped"}:
            self.session.add(event)
        elif event == "checking":
            self.session.add("checking", total=data["total"], skipped=data["skipped"])
        elif event in {"match", "no-match"}:
            self.session.add(event, label=data["label"])
        elif event == "reporting":
            self.session.add("reporting", count=data["count"])
        elif event == "track":
            self.session.add(
                "track",
                index=data["index"],
                total=data["total"],
                id=data["item"].id,
                label=data["item"].label,
            )
        elif event == "track-ready":
            result = data["result"]
            self.session.add(
                "track-ready",
                id=data["item"].id,
                format=result.format,
                bitrate=result.bitrate,
                size=result.file_size,
            )
        elif event == "track-failed":
            self.session.add("track-failed", id=data["item"].id, error=data["error"])
        elif event in {"writing", "playlists", "removing", "artwork"}:
            self.session.add(event, count=data.get("count", 0))


def _summarise(report: sync_engine.Report, *, dry_run: bool) -> dict[str, Any]:
    return {
        "dryRun": dry_run,
        "status": report.status,
        "synced": report.synced,
        "failed": [{"label": r.label, "error": r.error} for r in report.failed],
        "removed": report.removed,
        "playlists": report.playlists_written,
        "artwork": report.artwork_linked,
        "artworkError": report.artwork_error,
        "backedUp": report.backed_up,
        "excluded": len(report.plan.excluded),
        "message": report.message,
        "toDownload": len(report.plan.to_download),
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _make_handler(gui: GuiServer):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SyncMyPod"
        sys_version = ""

        # -- plumbing -------------------------------------------------------

        def log_message(self, fmt: str, *args: Any) -> None:
            # The default handler prints every request to stderr, which would
            # bury the sync's own output.
            logger.debug("gui: " + fmt, *args)

        def _send(
            self,
            status: int,
            body: bytes,
            content_type: str,
            extra: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            # This page never needs to send a referrer anywhere, and the token
            # is in the URL on first load.
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: Any) -> None:
            self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

        def _authorised(self) -> bool:
            """A token from the cookie, the header, or the opening URL.

            The URL form only happens once, when the browser is first opened;
            the cookie carries it from then on, so the token does not sit in the
            address bar for the rest of the session.
            """
            cookies = SimpleCookie(self.headers.get("Cookie") or "")
            morsel = cookies.get(COOKIE_NAME)
            if morsel and secrets.compare_digest(morsel.value, gui.session.token):
                return True
            header = self.headers.get("X-SyncMyPod-Token") or ""
            return bool(header) and secrets.compare_digest(header, gui.session.token)

        def _host_is_local(self) -> bool:
            """Refuse a Host header pointing somewhere else.

            A hostile DNS name resolving to 127.0.0.1 would otherwise let a web
            page treat this server as its own origin and read its responses.
            """
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
            return host in {"127.0.0.1", "localhost", "::1"}

        # -- routes ---------------------------------------------------------

        def do_GET(self) -> None:
            if not self._host_is_local():
                self._json(403, {"error": "This server only answers to localhost."})
                return

            parsed = urlparse(self.path)
            path = parsed.path

            if path == "/":
                self._serve_index(parse_qs(parsed.query).get("t", [""])[0])
                return

            if not self._authorised():
                self._json(
                    401, {"error": "Open this page from the link the application printed."}
                )
                return
            gui.touch()

            if path == "/api/ping":
                # The window's way of saying it is still there. See
                # GuiServer._last_seen for why the browser process cannot be
                # asked instead.
                self._json(200, {"ok": True})
                return

            if path == "/api/state":
                self._json(200, gui.state(self.headers.get("User-Agent") or ""))
            elif path == "/api/events":
                since = int(parse_qs(parsed.query).get("since", ["0"])[0] or 0)
                self._json(
                    200,
                    {
                        "events": gui.session.since(since),
                        "running": gui.session.running,
                        "summary": gui.session.summary,
                        "error": gui.session.error,
                    },
                )
            elif path.startswith("/static/"):
                self._serve_static(path[len("/static/") :])
            else:
                self._json(404, {"error": "Not found."})

        def do_POST(self) -> None:
            if not self._host_is_local():
                self._json(403, {"error": "This server only answers to localhost."})
                return
            if not self._authorised():
                self._json(
                    401, {"error": "Open this page from the link the application printed."}
                )
                return

            gui.touch()
            body = self._read_json()
            path = urlparse(self.path).path

            if path == "/api/sync":
                limit = body.get("limit")
                backup = body.get("backup")
                self._json(
                    200,
                    gui.start(
                        dry_run=bool(body.get("dryRun")),
                        remove=bool(body.get("remove")),
                        limit=int(limit) if limit else None,
                        backup=None if backup is None else bool(backup),
                    ),
                )
            elif path == "/api/check-matches":
                self._json(200, gui.start_match_check())
            elif path == "/api/cancel":
                self._json(200, gui.cancel())
            elif path == "/api/eject":
                self._json(200, gui.eject(str(body.get("mount") or "")))
            elif path == "/api/pair":
                self._json(
                    200,
                    gui.pair(
                        str(body.get("server") or ""),
                        str(body.get("code") or ""),
                        str(body.get("deviceName") or ""),
                    ),
                )
            elif path == "/api/settings":
                self._json(200, gui.save_settings(body))
            elif path == "/api/unpair":
                self._json(200, gui.unpair())
            elif path == "/api/youtube/check":
                self._json(200, gui.youtube_check())
            elif path == "/api/youtube/sign-in":
                self._json(
                    200,
                    gui.youtube_sign_in(
                        str(body.get("browser") or ""),
                        self.headers.get("User-Agent", ""),
                    ),
                )
            elif path == "/api/youtube/use-cookies":
                self._json(200, gui.youtube_use_cookies(str(body.get("path") or "")))
            elif path == "/api/youtube/sign-out":
                self._json(200, gui.youtube_sign_out())
            else:
                self._json(404, {"error": "Not found."})

        def _read_json(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return {}
            if length <= 0 or length > 64 * 1024:
                return {}
            try:
                decoded = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, OSError):
                return {}
            return decoded if isinstance(decoded, dict) else {}

        def _serve_index(self, token: str) -> None:
            """The one request allowed to carry the token in the URL.

            It is exchanged for a cookie immediately, so a reload or a
            screenshot of the address bar does not carry the credential.
            """
            gui.touch()
            valid_token = bool(token) and secrets.compare_digest(token, gui.session.token)
            if not self._authorised() and not valid_token:
                self._send(
                    401,
                    b"Open this page from the link the application printed.",
                    "text/plain; charset=utf-8",
                )
                return

            html = (STATIC / "index.html").read_bytes()
            self._send(
                200,
                html,
                "text/html; charset=utf-8",
                {
                    "Set-Cookie": (
                        f"{COOKIE_NAME}={gui.session.token}; Path=/; SameSite=Strict; HttpOnly"
                    )
                },
            )

        def _serve_static(self, name: str) -> None:
            # Resolved and checked against the static directory, so a crafted
            # path cannot walk out of it and read the config file.
            target = (STATIC / name).resolve()
            if not target.is_file() or STATIC.resolve() not in target.parents:
                self._json(404, {"error": "Not found."})
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), content_type)

    return Handler


def serve(*, open_browser: bool = True, port: int = 0) -> GuiServer:
    """Start the GUI and, unless told otherwise, open it."""
    gui = GuiServer(port=port)
    if open_browser:
        open_in_browser(gui.url)
    return gui


def open_in_browser(url: str) -> None:
    """Hand the address to the default browser, shortly.

    Delayed, because the browser can request the page before the server is
    accepting connections and show its own "cannot connect" instead - which
    looks exactly like the application having failed to start.
    """
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()
