"""The double-clicked application: the window, and no console behind it.

A second script rather than a flag on the first, because PyInstaller decides
``console`` per executable and the two builds want opposite answers. Both are
produced from one analysis of the same code, so there is no duplication beyond
this file.

    SyncMyPod.exe   this - windowed, opens the application
    syncmypod.exe   the console build, for `syncmypod sync` and the rest
"""

from __future__ import annotations

import sys

from entry import windowed

if __name__ == "__main__":
    sys.exit(windowed())
