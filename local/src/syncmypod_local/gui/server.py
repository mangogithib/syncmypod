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
from ..api import ApiError

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

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    # -- actions the page can ask for ---------------------------------------

    def state(self) -> dict[str, Any]:
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
            "running": self.session.running,
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

    def start(self, *, dry_run: bool, remove: bool, limit: int | None) -> dict[str, Any]:
        """Begin a run on a worker thread, or refuse if one is already going."""
        if self.session.running:
            return {"started": False, "error": "A sync is already running."}

        self.session.reset()
        self.session.running = True
        self._worker = threading.Thread(
            target=self._run,
            kwargs={"dry_run": dry_run, "remove": remove, "limit": limit},
            daemon=True,
        )
        self._worker.start()
        return {"started": True}

    def cancel(self) -> dict[str, Any]:
        """Ask the run to stop at the next track boundary.

        Deliberately not an abort. Stopping between tracks means the database is
        never interrupted mid-write, and what has already been copied stays
        usable.
        """
        self.session.cancelled = True
        self.session.add("cancelling")
        return {"cancelling": True}

    def _run(self, *, dry_run: bool, remove: bool, limit: int | None) -> None:
        try:
            report = sync_engine.run(
                config_module.load(),
                dry_run=dry_run,
                remove=remove,
                limit=limit,
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
                "device", label=ipod.describe(), mount=str(ipod.mount_path),
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
        elif event == "backup":
            self.session.add("backup")
        elif event == "track":
            self.session.add(
                "track", index=data["index"], total=data["total"],
                id=data["item"].id, label=data["item"].label,
            )
        elif event == "track-ready":
            result = data["result"]
            self.session.add(
                "track-ready", id=data["item"].id, format=result.format,
                bitrate=result.bitrate, size=result.file_size,
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

        def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
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
                self._json(401, {"error": "Open this page from the link the application printed."})
                return

            if path == "/api/state":
                self._json(200, gui.state())
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
                self._serve_static(path[len("/static/"):])
            else:
                self._json(404, {"error": "Not found."})

        def do_POST(self) -> None:
            if not self._host_is_local():
                self._json(403, {"error": "This server only answers to localhost."})
                return
            if not self._authorised():
                self._json(401, {"error": "Open this page from the link the application printed."})
                return

            body = self._read_json()
            path = urlparse(self.path).path

            if path == "/api/sync":
                limit = body.get("limit")
                self._json(
                    200,
                    gui.start(
                        dry_run=bool(body.get("dryRun")),
                        remove=bool(body.get("remove")),
                        limit=int(limit) if limit else None,
                    ),
                )
            elif path == "/api/cancel":
                self._json(200, gui.cancel())
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
                        f"{COOKIE_NAME}={gui.session.token}; Path=/; "
                        "SameSite=Strict; HttpOnly"
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
        threading.Timer(0.3, lambda: webbrowser.open(gui.url)).start()
    return gui
