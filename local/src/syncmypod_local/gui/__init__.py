"""A window onto the sync engine.

The interface is a page, served over the loopback interface. Chosen over a
desktop toolkit for three reasons: it adds almost nothing to the packaged
executable, it can use the web tool's own design tokens so the two halves look
like one product, and the engine already reports progress as events rather than
printing, so the browser and the terminal are two renderings of one run.

That page is shown in a window of its own rather than a browser tab - see
``window.py``, which wraps this exact page in the webview the operating system
already has. None of the reasoning above depends on which of the two is used.

What it is not is a web application. It binds to the loopback interface on a
port the operating system picks, it is reachable only with a token generated at
startup, and it exists for as long as the command runs. Nothing here is exposed
to a network.
"""

from __future__ import annotations

from .server import GuiServer, open_in_browser, serve

__all__ = ["GuiServer", "open_in_browser", "serve"]
