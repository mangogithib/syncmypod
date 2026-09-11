"""The scratch directory a sync downloads into, and its guaranteed removal.

"Nothing downloaded outlives the sync" is one of the project's stated rules, so
it gets its own module rather than a ``finally`` block somewhere in the
orchestration. The rule matters for two reasons: the tool should not quietly
accumulate a second copy of a music library on someone's system drive, and a
half-finished download left behind would be picked up as if it were complete.

Cleanup runs even when a sync crashes, and a workspace left behind by a process
that was killed outright is removed by the next run.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from types import TracebackType

logger = logging.getLogger(__name__)

# Specific enough that nothing else can match it. It was "syncmypod-", and
# purge_abandoned() deletes anything matching it that is a few hours old - which
# meant the build directory, "syncmypod-build", was a candidate for deletion by
# a sync running at the same time. A prefix used for automatic removal should
# name exactly one thing.
_PREFIX = "syncmypod-run-"

# How long a workspace from a previous run has to be untouched before it is
# treated as abandoned rather than as another sync in progress. Generous,
# because deleting a live sync's files would be far worse than leaving a stale
# directory for an hour.
_ABANDONED_AFTER_SECONDS = 6 * 60 * 60


class Workspace:
    """A temporary directory that deletes itself.

    Used as a context manager::

        with Workspace() as work:
            path = work.path / "track.m4a"

    The directory is gone when the block exits, however it exits.
    """

    def __init__(self, parent: Path | None = None, *, keep: bool = False):
        # `keep` exists for debugging a failed conversion, and is deliberately
        # awkward to reach: it is a --keep-downloads flag, off by default, and
        # the path is printed so nothing is left behind silently.
        self._keep = keep
        self._parent = parent
        self.path: Path = Path()

    def __enter__(self) -> Workspace:
        base = self._parent or Path(tempfile.gettempdir())
        base.mkdir(parents=True, exist_ok=True)
        purge_abandoned(base)
        self.path = Path(tempfile.mkdtemp(prefix=_PREFIX, dir=base))
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        if not self.path or not self.path.exists():
            return
        if self._keep:
            logger.warning("Keeping downloads in %s as requested", self.path)
            return
        removed = _remove_tree(self.path)
        if not removed:
            # Worth saying out loud. A workspace that could not be deleted is
            # usually a file still open - on Windows, an antivirus scanner
            # holding a handle - and the user should know a copy of their music
            # is still on disk.
            logger.warning(
                "Could not fully delete the download folder %s. "
                "It holds downloaded audio and can be removed by hand.",
                self.path,
            )

    def track_dir(self, track_id: int) -> Path:
        """A private directory per track.

        Separate directories rather than one flat folder, because a transcode
        writes a second file beside the source and two tracks whose search
        results have the same name would otherwise collide.
        """
        directory = self.path / str(track_id)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def discard(self, track_id: int) -> None:
        """Delete one track's files as soon as it has been written to the iPod.

        Called per track rather than waiting for the end of the run, so peak
        disk use is one track rather than a whole library.
        """
        _remove_tree(self.path / str(track_id))


def purge_abandoned(base: Path) -> int:
    """Remove workspaces left by a previous run that died without cleaning up.

    A process killed outright - or a machine that lost power mid-sync - leaves
    the directory behind, and nothing else would ever delete it. Returns how
    many were removed.
    """
    removed = 0
    cutoff = time.time() - _ABANDONED_AFTER_SECONDS
    try:
        candidates = list(base.glob(f"{_PREFIX}*"))
    except OSError:
        return 0

    for candidate in candidates:
        try:
            if not candidate.is_dir() or candidate.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        if _remove_tree(candidate):
            removed += 1
            logger.info("Removed an abandoned download folder: %s", candidate)
    return removed


def _remove_tree(path: Path) -> bool:
    """Delete a directory, reporting whether it actually went.

    Retried once because on Windows a file can be briefly locked by a scanner
    immediately after it is closed, and a single retry turns that from a warning
    into a non-event.
    """
    if not path.exists():
        return True
    for attempt in (0, 1):
        try:
            shutil.rmtree(path, **_RMTREE_HANDLER)
            return True
        except OSError:
            if attempt == 0:
                time.sleep(0.4)
    return not path.exists()


def _make_writable(func, path, _exc):  # type: ignore[no-untyped-def]
    """rmtree error handler: clear a read-only bit and try the operation again.

    Downloaded files are occasionally written read-only, and on Windows that is
    enough to make deletion fail.
    """
    try:
        os.chmod(path, 0o700)
        func(path)
    except OSError:
        pass


# `onexc` replaced `onerror` in Python 3.12, and this project still supports
# 3.11 because pyPodLib does. The two differ only in what the third argument is -
# an exception rather than the older exc_info triple - and the handler above
# ignores it either way, so choosing the keyword is the whole difference.
_RMTREE_HANDLER = (
    {"onexc": _make_writable} if sys.version_info >= (3, 12) else {"onerror": _make_writable}
)
