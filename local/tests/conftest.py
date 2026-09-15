"""Keeps the test suite out of the machine it is running on.

Two directories are chosen by the platform when nothing overrides them - the
configuration directory and the backup directory - and until now the tests
overrode the first one only where a test happened to care, and the second one
never. So every test that ran a sync took a real iPod backup into
``%LOCALAPPDATA%\\SyncMyPod\\backups`` on the developer's own machine, and on a
CI runner.

That is untidy, and it is also a bug that failed a build. The backup store is
content addressed: two tests backing up two virtual devices with identical
contents produce the same blob hash, and the second one renames its temporary
file onto a name that already exists. On Windows that raises, pypodlib turns it
into a `DeviceWriteSafetyError`, and the test fails somewhere unrelated to
whatever it was testing - intermittently, because it depends on which tests ran
first.

Both are now redirected per test. A test that wants to assert something about
the configuration can still set `SYNCMYPOD_CONFIG_DIR` itself; setting it again
simply wins.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolated_user_directories(tmp_path, monkeypatch):
    """Give every test its own config and backup directories."""
    monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SYNCMYPOD_BACKUP_DIR", str(tmp_path / "backups"))
