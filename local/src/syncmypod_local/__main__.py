"""Allows `python -m syncmypod_local`, which is how the app runs before it is
packaged into a single executable."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
