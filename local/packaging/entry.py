"""The packaged application's entry point.

A separate file rather than pointing PyInstaller at ``cli.py`` directly, for two
reasons. PyInstaller traces imports from whatever script it is given, and giving
it a module that is also imported normally causes it to be analysed twice under
two names. And a frozen build needs multiprocessing's freeze support installed
before anything else runs, which is not something the CLI should have to know
about.
"""

from __future__ import annotations

import multiprocessing
import sys


def main() -> int:
    # Without this, any library that starts a process would re-run this
    # executable from the top rather than spawning a worker - which on Windows
    # means the application launching itself repeatedly. Nothing here does that
    # today; it costs one line and removes a whole category of confusing bug if
    # anything ever does.
    multiprocessing.freeze_support()

    from syncmypod_local.cli import main as cli_main

    return cli_main()


def windowed() -> int:
    """The entry point for SyncMyPod.exe, the one people double-click.

    Built with ``console=False``, so this process has no console at all - which
    is the point. It also means ``sys.stdout`` and ``sys.stderr`` are None, and
    anything that writes to them raises. So there is nothing to write to, and
    the only argument that could be passed is the one that opens the window.

    The console build, ``syncmypod.exe``, is still there beside it for
    ``syncmypod sync`` and everything else.
    """
    multiprocessing.freeze_support()

    # rich builds its Console against sys.stdout at import time, and a windowed
    # build has none. Giving it somewhere harmless to write is cheaper than
    # teaching every print site to check.
    import io

    if sys.stdout is None:
        sys.stdout = io.StringIO()
    if sys.stderr is None:
        sys.stderr = io.StringIO()

    from syncmypod_local.cli import main as cli_main

    return cli_main(["gui"])


if __name__ == "__main__":
    sys.exit(main())
