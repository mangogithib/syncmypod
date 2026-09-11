"""A window onto the sync engine, served to the local browser.

Chosen over a desktop toolkit for three reasons. It adds no dependency, so the
packaged executable stays small. It can use the web tool's own design tokens, so
the two halves of the project look like one product rather than two. And the
engine already reports progress as events rather than printing, so the browser
and the terminal are two renderings of exactly the same run.

What it is not is a web application. It binds to the loopback interface on a
port the operating system picks, it is reachable only with a token generated at
startup, and it exists for as long as the command runs. Nothing here is exposed
to a network.
"""

from __future__ import annotations

from .server import GuiServer, serve

__all__ = ["GuiServer", "serve"]
