"""The application as a window rather than a browser tab.

**What this changes, and what it deliberately does not.** The interface is the
same page served by ``gui/server.py`` - every line of HTML, CSS and JavaScript
is untouched. This module only decides how that page is shown.

**Why a browser in app mode rather than a GUI toolkit.** A window with no tabs,
no address bar, its own taskbar entry and its own icon is what people mean by
"an application" - and every Chromium browser will draw one on request with
``--app=<url>``. Windows always has Edge, so on the platform this is built for
there is nothing to install and nothing to bundle.

pywebview was tried first, in 0.1.8, and it failed in the packaged build:

    Could not open a window (Failed to resolve Python.Runtime.Loader.Initialize
    from ...\\_internal\\pythonnet\\runtime\\Python.Runtime.dll)

Its Windows backend hosts WebView2 through pythonnet, which needs a working
.NET runtime resolved from inside a frozen PyInstaller bundle. That is a class
of problem with no reliable fix from here, and it cost the download several
megabytes of .NET assemblies to not work. `--app=` needs neither.

**The dedicated profile is not optional.** Launching ``msedge --app=...`` with
the user's normal profile hands the request to the browser they already have
open and returns immediately - so there would be no process to wait on, and the
server would be shut down while the window was still on screen. A
``--user-data-dir`` of its own makes this a browser instance we launched and can
therefore wait for.

**It always falls back.** A window is nicer; it is not worth failing to start
over. With no Chromium browser the page opens in whatever the default browser
is, exactly as it did before any of this.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

WINDOW_SIZE = (1180, 860)

# Tried in order. Edge first because it is the one Windows is guaranteed to
# have; the rest are for a machine where somebody has removed it or for Linux.
_CANDIDATES = (
    "msedge",
    "chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave",
    "vivaldi",
)

# The usual install locations, for Windows, where none of the above is on PATH.
_WINDOWS_PATHS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def find_browser() -> str | None:
    """A Chromium browser that can draw an app window, or None."""
    for name in _CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == "win32":
        for path in _WINDOWS_PATHS:
            if Path(path).is_file():
                return path
    return None


def available() -> bool:
    return find_browser() is not None


def _profile_dir() -> Path:
    """Where the window's own browser profile lives.

    Beside the configuration rather than in the system temp directory, so it
    survives between runs - otherwise every launch is a cold start with no
    window position remembered.
    """
    from ..config import config_dir

    return config_dir() / "window-profile"


def run(server: object, *, title: str = "SyncMyPod") -> bool:
    """Show *server* in an app window, blocking until it is closed.

    Returns False without having touched the server if no window could be
    opened, so the caller can fall back to a browser. **The server is left
    running in that case** - shutting it down here and then handing its address
    to a browser is what 0.1.8 did, and it produced a connection refused page
    next to a console saying the application was running.
    """
    browser = find_browser()
    if browser is None:
        logger.info("No Chromium browser found; using the default browser instead")
        return False

    profile = _profile_dir()
    try:
        profile.mkdir(parents=True, exist_ok=True)
    except OSError as err:
        logger.info("Could not create %s (%s); using the browser instead", profile, err)
        return False

    command = [
        browser,
        f"--app={server.url}",
        f"--user-data-dir={profile}",
        f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
        # This window is the application. None of the browser's own furniture
        # belongs in it, and nothing here should be reporting to a browser
        # vendor about a page served from loopback.
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,TranslateUI",
        "--disable-background-networking",
        "--disable-sync",
    ]

    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Keeps the browser's own console off the application's window on
            # Windows, where a spawned process would otherwise attach to it.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except OSError as err:
        logger.warning("Could not start %s (%s); using the browser instead", browser, err)
        # The server has to keep running: the caller is about to hand its
        # address to the default browser.
        return False

    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()
    finally:
        # Closing the window ends the application, which is what closing an
        # application's only window should do.
        server.shutdown()

    return True
