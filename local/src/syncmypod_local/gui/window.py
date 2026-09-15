"""The application as a window rather than a browser tab.

**What this changes, and what it deliberately does not.** The interface is still
the same page served by ``gui/server.py`` - every line of HTML, CSS and
JavaScript is untouched. This module only puts it in a window of its own
instead of handing the address to whatever browser is set as default.

That was a decision recorded in the handover on 11 September, and it was the
right one at the time: a page served to the browser adds no dependency and
keeps the packaged executable small, where Tkinter would have meant rebuilding
the interface and PySide6 would have added about 150MB to a download. Nothing
about that reasoning has changed - which is why the answer here is pywebview,
about 1MB, wrapping the *existing* page in the webview the operating system
already ships. Windows has WebView2 behind Edge, macOS has WKWebView, Linux has
WebKitGTK.

**It always falls back.** A native window is nicer; it is not worth failing to
start over. If pywebview is missing, or the platform has no usable webview
runtime, the browser is opened exactly as before and the address is printed. A
user whose machine cannot do this gets the old behaviour rather than an error.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

# Big enough for the widest card at a comfortable width, small enough to open on
# a laptop without filling the screen. The page is responsive, so this is a
# starting size rather than a constraint.
WINDOW_SIZE = (1100, 820)
# Below this the layout starts stacking, which is fine on a phone and cramped in
# a window somebody is about to resize back.
MIN_WINDOW_SIZE = (760, 560)


def available() -> bool:
    """Whether a native window can be opened on this machine."""
    try:
        import webview  # noqa: F401
    except Exception:
        return False
    return True


def run(server: Any, *, title: str = "SyncMyPod") -> bool:
    """Show *server* in a native window, blocking until it is closed.

    Returns False without doing anything if no window could be opened, which
    leaves the caller free to fall back to a browser. The server is served on a
    background thread because pywebview needs the main thread: on macOS the UI
    event loop is only allowed to run there, and the same arrangement is used
    everywhere rather than having two different shapes of startup.
    """
    try:
        import webview
    except Exception as err:
        logger.info("No native window available (%s); using the browser instead", err)
        return False

    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()

    try:
        webview.create_window(
            title,
            server.url,
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=MIN_WINDOW_SIZE,
            # The page draws its own light and dark surfaces. Without this the
            # window flashes white before the first paint, which on a dark
            # theme is the first thing anybody notices.
            background_color="#f4f5f7",
        )
        # Closing the window ends the process, which is what closing an
        # application's only window should do. `http_server` is off because we
        # already have one - pywebview's is for serving local files.
        webview.start(debug=False, http_server=False)
    except Exception as err:
        # A missing WebView2 runtime lands here rather than at import. Falling
        # back is better than a traceback about a COM class not being
        # registered, which tells a user nothing they can act on.
        logger.warning("Could not open a window (%s); using the browser instead", err)
        return False
    finally:
        server.shutdown()

    return True
