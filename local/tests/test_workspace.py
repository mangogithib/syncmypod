"""The promise that nothing downloaded outlives the sync.

Stated as a rule in both READMEs and the API contract, so it is asserted rather
than trusted - including the awkward cases, which are the ones that would leave
a second copy of someone's music library on their system drive.
"""

from __future__ import annotations

import time

import pytest

from syncmypod_local import workspace


def test_the_directory_exists_inside_the_block_and_not_after(tmp_path):
    with workspace.Workspace(parent=tmp_path) as work:
        inside = work.path
        assert inside.is_dir()
        (inside / "downloaded.m4a").write_bytes(b"audio")
    assert not inside.exists()


def test_files_are_deleted_even_when_the_sync_crashes(tmp_path):
    """The case that matters. A sync will fail halfway; the files still go."""
    with pytest.raises(RuntimeError), workspace.Workspace(parent=tmp_path) as work:
        inside = work.path
        (inside / "half.part").write_bytes(b"incomplete")
        raise RuntimeError("the network went away")
    assert not inside.exists()


def test_files_are_deleted_when_the_user_interrupts(tmp_path):
    with pytest.raises(KeyboardInterrupt), workspace.Workspace(parent=tmp_path) as work:
        inside = work.path
        (inside / "half.part").write_bytes(b"incomplete")
        raise KeyboardInterrupt
    assert not inside.exists()


def test_a_track_is_discarded_as_soon_as_it_is_written(tmp_path):
    """Peak disk use is one batch, not one library."""
    with workspace.Workspace(parent=tmp_path) as work:
        first = work.track_dir(1)
        second = work.track_dir(2)
        (first / "a.m4a").write_bytes(b"audio")
        (second / "b.m4a").write_bytes(b"audio")

        work.discard(1)
        assert not first.exists()
        assert second.exists()


def test_discarding_a_track_that_was_never_started_is_harmless(tmp_path):
    with workspace.Workspace(parent=tmp_path) as work:
        work.discard(999)


def test_keep_downloads_leaves_them_for_inspection(tmp_path):
    """Off by default, and the path is logged so nothing is left silently."""
    with workspace.Workspace(parent=tmp_path, keep=True) as work:
        inside = work.path
        (inside / "kept.m4a").write_bytes(b"audio")
    assert inside.exists()


class TestAbandonedWorkspaces:
    """A process killed outright leaves a directory nothing else would remove."""

    def test_an_old_one_is_purged_by_the_next_run(self, tmp_path):
        stale = tmp_path / "syncmypod-deadbeef"
        stale.mkdir()
        (stale / "orphan.m4a").write_bytes(b"audio")
        old = time.time() - (24 * 60 * 60)
        import os

        os.utime(stale, (old, old))

        with workspace.Workspace(parent=tmp_path):
            pass
        assert not stale.exists()

    def test_a_recent_one_is_left_alone(self, tmp_path):
        """It may be another sync running right now. Deleting it would be worse."""
        active = tmp_path / "syncmypod-inprogress"
        active.mkdir()
        (active / "downloading.part").write_bytes(b"partial")

        with workspace.Workspace(parent=tmp_path):
            pass
        assert active.exists()

    def test_an_unrelated_directory_is_never_touched(self, tmp_path):
        other = tmp_path / "someone-elses-data"
        other.mkdir()
        old = time.time() - (24 * 60 * 60)
        import os

        os.utime(other, (old, old))

        with workspace.Workspace(parent=tmp_path):
            pass
        assert other.exists()


def test_a_read_only_file_is_still_removed(tmp_path):
    """Downloads are occasionally written read-only, which stops deletion dead."""
    import os
    import stat

    with workspace.Workspace(parent=tmp_path) as work:
        inside = work.path
        locked = inside / "locked.m4a"
        locked.write_bytes(b"audio")
        os.chmod(locked, stat.S_IREAD)
    assert not inside.exists()
