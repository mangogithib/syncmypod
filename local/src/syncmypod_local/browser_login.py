"""Signing in to YouTube in a browser this application launched itself.

**Why not just read the browser the user already uses.** That is what
`youtube.sign_in` does, and on Windows it increasingly cannot work. Chromium
seals every cookie value with App-Bound Encryption, so the value on disk is
undecryptable by anything but Chrome itself, and the file is locked besides
while the browser runs. Measured on a real machine: 961 of 961 Chrome cookies
sealed, with a perfectly good YouTube session sitting inside them. No amount of
signing in again changes that.

**What works instead.** Start a browser - the user's own installed Chrome or
Edge, not a bundled one - pointed at a profile directory this application owns,
with the DevTools protocol enabled. The user signs in to YouTube in that window
exactly as they would anywhere. The cookies are then read *out of the running
browser* over that protocol rather than off disk, so nothing is ever decrypted
and the sealing simply does not apply.

The profile is kept. A second sign-in restores the session on its own and needs
no typing, which is what makes this a one-off rather than a chore.

**Three things done deliberately.**

*The window is a real browser, not an automated one.* No `--headless`, no
`--enable-automation`, no WebDriver flags. A browser started that way sets
`navigator.webdriver` and Google refuses to accept a password in it. The only
switches passed are the profile, the debugging port, and the two that stop a
fresh profile opening onboarding tabs over the top of the login page.

*Only youtube.com cookies leave this module.* The browser profile will hold
whatever the user visits in it and the protocol will hand over all of it on
request, so the filtering happens here, before the caller sees anything.

*Waiting is done by looking for the cookie that means "signed in".* There is no
event to subscribe to, and guessing from the page URL is wrong the moment Google
changes a redirect. `LOGIN_INFO` on youtube.com appears when, and only when, an
account is attached to the session.
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# The cookies that only exist once an account is attached. Any one of them is
# enough; which are present varies with how the account signed in.
SIGNED_IN_MARKERS = frozenset({"LOGIN_INFO", "SID", "__Secure-1PSID", "__Secure-3PSID"})

# `Storage.getCookies`, not `Network.getAllCookies`. The connection here is to
# the *browser* target rather than to a page, and Network is a page-level domain
# - asking for it there answers "'Network.getAllCookies' wasn't found", which
# reads like a protocol version problem and is not one.
COOKIE_METHOD = "Storage.getCookies"

PROFILE_DIRNAME = "browser-profile"
START_URL = "https://www.youtube.com/"
# Long enough to sign in without hurrying, short enough that the browser's own
# request holds. The page waits on this call, and a fetch left open for five
# minutes is at the mercy of whatever the browser decides about idle
# connections. Retrying is nearly free - the profile below is kept, so a second
# attempt finds the session already there and returns in seconds - so a shorter
# wait with a clear retry beats a longer one that may be dropped.
DEFAULT_TIMEOUT = 180.0


class BrowserLoginError(Exception):
    """The browser sign-in could not be completed, phrased for a user."""


@dataclass(frozen=True, slots=True)
class Browser:
    name: str
    executable: Path


# ---------------------------------------------------------------------------
# Finding a browser
# ---------------------------------------------------------------------------


def _candidates() -> list[tuple[str, Path]]:
    """Where a Chromium browser is installed, most preferred first.

    Chrome before Edge only because a Chrome window is the one people recognise
    as "a browser"; either works identically for this.
    """
    found: list[tuple[str, Path]] = []

    if sys.platform in ("win32", "cygwin"):
        program_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        for label, parts in (
            ("Chrome", r"Google\Chrome\Application\chrome.exe"),
            ("Edge", r"Microsoft\Edge\Application\msedge.exe"),
            ("Brave", r"BraveSoftware\Brave-Browser\Application\brave.exe"),
            ("Vivaldi", r"Vivaldi\Application\vivaldi.exe"),
        ):
            for root in (program_files, program_files_x86, local):
                if not root:
                    continue
                found.append((label, Path(root) / parts))
    elif sys.platform == "darwin":
        found += [
            ("Chrome", Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
            ("Edge", Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")),
            ("Brave", Path("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")),
        ]
    else:
        for label, names in (
            ("Chrome", ("google-chrome", "google-chrome-stable")),
            ("Chromium", ("chromium", "chromium-browser")),
            ("Edge", ("microsoft-edge",)),
            ("Brave", ("brave-browser",)),
        ):
            for name in names:
                located = shutil.which(name)
                if located:
                    found.append((label, Path(located)))

    return found


def find_browser() -> Browser | None:
    """The first installed Chromium browser, or None if there is none."""
    for label, path in _candidates():
        if path.is_file():
            return Browser(name=label, executable=path)
    return None


# ---------------------------------------------------------------------------
# A very small DevTools protocol client
# ---------------------------------------------------------------------------
#
# Enough of RFC 6455 to send a JSON command to a browser on this machine and
# read the reply, and no more. A dependency was weighed and not taken: this
# talks to one local process over an unencrypted socket, and a general-purpose
# WebSocket library would be carrying proxy, TLS and extension handling that
# cannot apply here.


class _Socket:
    """A WebSocket connection to the browser's debugging endpoint."""

    def __init__(self, url: str, timeout: float = 30.0) -> None:
        if not url.startswith("ws://"):
            raise BrowserLoginError(f"Unexpected debugger address: {url}")
        rest = url[len("ws://") :]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")

        self._sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self._sock.settimeout(timeout)
        self._buffer = b""
        self._next_id = 0

        key = base64.b64encode(secrets.token_bytes(16)).decode()
        handshake = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(handshake.encode())

        while b"\r\n\r\n" not in self._buffer:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise BrowserLoginError("The browser closed the debugging connection.")
            self._buffer += chunk
        head, _, self._buffer = self._buffer.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise BrowserLoginError("The browser refused the debugging connection.")

    # -- framing ------------------------------------------------------------

    def _recv_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise BrowserLoginError("The browser window was closed.")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def _send_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        # Every client frame must be masked; the server's are never masked.
        mask = secrets.token_bytes(4)
        length = len(payload)
        header = bytes([0x80 | opcode])
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 1 << 16:
            header += bytes([0x80 | 126]) + struct.pack(">H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", length)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self._sock.sendall(header + mask + masked)

    def _read_message(self) -> str:
        """One complete text message, reassembling continuation frames."""
        chunks: list[bytes] = []
        while True:
            first, second = self._recv_exact(2)
            final = bool(first & 0x80)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", self._recv_exact(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._recv_exact(8))
            payload = self._recv_exact(length) if length else b""

            if opcode == 0x8:  # close
                raise BrowserLoginError("The browser window was closed.")
            if opcode == 0x9:  # ping
                self._send_frame(payload, opcode=0xA)
                continue
            if opcode == 0xA:  # pong
                continue

            chunks.append(payload)
            if final:
                return b"".join(chunks).decode("utf-8", errors="replace")

    # -- protocol -----------------------------------------------------------

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        message_id = self._next_id
        self._send_frame(
            json.dumps({"id": message_id, "method": method, "params": params or {}}).encode()
        )
        # Events arrive on the same socket and are not replies; skip anything
        # that is not the answer to what was just asked.
        while True:
            message = json.loads(self._read_message())
            if message.get("id") != message_id:
                continue
            if "error" in message:
                raise BrowserLoginError(f"{method} failed: {message['error'].get('message')}")
            return message.get("result") or {}

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._send_frame(b"", opcode=0x8)
        with contextlib.suppress(Exception):
            self._sock.close()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _debugger_url(port: int, deadline: float) -> str:
    """Wait for the browser to start listening, then its protocol address."""
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            # A fixed localhost address, not user input.
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=2
            ) as response:
                payload = json.loads(response.read().decode())
            url = payload.get("webSocketDebuggerUrl")
            if url:
                return url
        except Exception as err:  # not up yet
            last = err
        time.sleep(0.3)
    raise BrowserLoginError(f"The browser did not start within the time allowed ({last}).")


# ---------------------------------------------------------------------------
# The sign-in itself
# ---------------------------------------------------------------------------


def profile_dir(base: Path) -> Path:
    return base / PROFILE_DIRNAME


def has_profile(base: Path) -> bool:
    """Whether a sign-in has already happened in a browser started here.

    What makes a silent refresh possible: the profile holds the session, so
    starting it again restores it without a password. An empty directory does
    not count - a profile Chrome has actually written to has a Local State file
    in it.
    """
    profile = profile_dir(base)
    return profile.is_dir() and any(profile.iterdir())


def _youtube_only(cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kept = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "").lstrip(".").lower()
        if domain == "youtube.com" or domain.endswith(".youtube.com"):
            kept.append(cookie)
    return kept


def _is_signed_in(cookies: list[dict[str, Any]]) -> bool:
    return any(cookie.get("name") in SIGNED_IN_MARKERS for cookie in _youtube_only(cookies))


def collect_cookies(
    base_dir: Path,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    on_opened=None,
    headless: bool = False,
) -> list[dict[str, Any]]:
    """Open a browser, wait for a YouTube sign-in, and return its cookies.

    Only youtube.com cookies are returned. ``on_opened`` is called with the
    browser's name once the window is up, so a caller can say what is happening
    rather than appearing to hang while somebody types a password.

    ``headless`` is for renewing a session that already exists, never for
    establishing one. Google refuses to accept a password in a browser it can
    tell is automated, which is exactly why the sign-in window is a real one -
    but restoring a session the profile already holds involves no password and
    no typing, so it has no reason to appear on screen. See
    `youtube.refresh_session`.
    """
    browser = find_browser()
    if browser is None:
        raise BrowserLoginError(
            "No Chrome, Edge or Brave was found on this computer to sign in with. "
            "Install one of them, or use a cookies.txt file instead."
        )

    profile = profile_dir(base_dir)
    profile.mkdir(parents=True, exist_ok=True)
    port = _free_port()

    # The executable is a path this module resolved itself, never user input.
    arguments = [
        str(browser.executable),
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={port}",
        # A fresh profile otherwise opens onboarding and default-browser
        # tabs in front of the page the user is meant to be looking at.
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
    ]
    if headless:
        # The "new" headless mode, which is a real browser without a window
        # rather than the old separate implementation that behaved differently
        # in ways that mattered. --disable-gpu is what keeps it quiet on
        # Windows, where the old mode complains without it.
        arguments += ["--headless=new", "--disable-gpu", "--window-size=1280,900"]
    arguments.append(START_URL)

    process = subprocess.Popen(
        arguments,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        # No console window for the browser on Windows. Without it, a silent
        # refresh from the packaged windowed build flashes a black box.
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if sys.platform in ("win32", "cygwin")
        else 0,
    )

    deadline = time.monotonic() + timeout
    connection: _Socket | None = None
    try:
        connection = _Socket(_debugger_url(port, min(deadline, time.monotonic() + 30)))
        if on_opened:
            on_opened(browser.name)

        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise BrowserLoginError(
                    "The browser was closed before the sign-in finished. "
                    "Press Sign in again and leave the window open until it says so."
                )
            cookies = connection.call(COOKIE_METHOD).get("cookies") or []
            if _is_signed_in(cookies):
                return _youtube_only(cookies)
            time.sleep(2.0)

        raise BrowserLoginError(
            "Timed out waiting for the sign-in. Nothing is lost: the browser "
            "profile is kept, so press Sign in again and carry on from where "
            "you got to."
        )
    finally:
        if connection is not None:
            connection.close()
        # Asked to close first: terminating it outright can leave the profile
        # marked as having crashed, which greets the user with a restore bar the
        # next time round.
        with contextlib.suppress(Exception):
            process.terminate()
        with contextlib.suppress(Exception):
            process.wait(timeout=10)
