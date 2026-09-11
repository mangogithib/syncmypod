"""The record kept on the iPod of what this tool put there.

The point of the ledger is that removals are exact. Everything here is
ultimately about not deleting music the user did not ask to have deleted.
"""

from __future__ import annotations

import json

from syncmypod_local import ledger

SERVER = "https://pod.example.org:8444"
TRACK = {"id": 7, "title": "Second Sunrise", "artist": "Aurora Kane", "album": "Longer Days"}


def test_an_iPod_with_no_record_starts_empty(tmp_path):
    record = ledger.load(tmp_path, SERVER, 1)
    assert record.entries == {}


def test_what_is_written_survives_a_reload(tmp_path):
    record = ledger.load(tmp_path, SERVER, 1)
    record.record(
        7,
        location=":iPod_Control:Music:F00:ABCD.m4a",
        track=TRACK,
        file_format="m4a",
        size=4096,
    )
    record.save()

    reloaded = ledger.load(tmp_path, SERVER, 1)
    entry = reloaded.entries[7]
    assert entry.location == ":iPod_Control:Music:F00:ABCD.m4a"
    assert entry.title == "Second Sunrise"
    assert entry.format == "m4a"
    assert entry.size == 4096


def test_it_lives_where_the_device_keeps_its_own_configuration(tmp_path):
    """On the iPod, not on this machine - so a second computer sees the history."""
    record = ledger.load(tmp_path, SERVER, 1)
    record.record(7, location=":x", track=TRACK, file_format="m4a", size=1)
    record.save()
    assert (tmp_path / "iPod_Control" / "Device" / "SyncMyPod.json").exists()


def test_two_libraries_can_share_one_iPod(tmp_path):
    """The second sync must not erase the first account's history.

    Without this, syncing a shared iPod from two accounts would make each one
    think the other's tracks were unknown - and unknown tracks are never
    removed, so the failure is silent and the device fills up.
    """
    first = ledger.load(tmp_path, SERVER, 1)
    first.record(7, location=":a", track=TRACK, file_format="m4a", size=1)
    first.save()

    second = ledger.load(tmp_path, SERVER, 2)
    assert second.entries == {}
    second.record(9, location=":b", track=TRACK, file_format="m4a", size=1)
    second.save()

    assert ledger.load(tmp_path, SERVER, 1).entries.keys() == {7}
    assert ledger.load(tmp_path, SERVER, 2).entries.keys() == {9}


def test_the_same_account_on_a_different_server_is_a_different_library(tmp_path):
    record = ledger.load(tmp_path, SERVER, 1)
    record.record(7, location=":a", track=TRACK, file_format="m4a", size=1)
    record.save()
    assert ledger.load(tmp_path, "https://other.example", 1).entries == {}


def test_forgetting_a_track_removes_it(tmp_path):
    record = ledger.load(tmp_path, SERVER, 1)
    record.record(7, location=":a", track=TRACK, file_format="m4a", size=1)
    record.forget(7)
    record.save()
    assert ledger.load(tmp_path, SERVER, 1).entries == {}


class TestDegradingGracefully:
    """The ledger is a convenience. Losing it must never stop a sync."""

    def test_a_corrupt_file_is_ignored_rather_than_fatal(self, tmp_path):
        path = tmp_path / "iPod_Control" / "Device" / "SyncMyPod.json"
        path.parent.mkdir(parents=True)
        path.write_text("{ this is not json")

        record = ledger.load(tmp_path, SERVER, 1)
        assert record.entries == {}

    def test_an_entry_with_nonsense_in_it_is_skipped_not_fatal(self, tmp_path):
        path = tmp_path / "iPod_Control" / "Device" / "SyncMyPod.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "libraries": {
                        ledger.library_key(SERVER, 1): {
                            "tracks": {
                                "notanumber": {"location": ":a"},
                                "7": {"location": ":b", "title": "Fine"},
                            }
                        }
                    },
                }
            )
        )
        record = ledger.load(tmp_path, SERVER, 1)
        assert record.entries.keys() == {7}

    def test_writing_to_a_device_that_refuses_it_does_not_raise(self, tmp_path):
        """A full or read-only iPod must not fail a sync at the last step."""
        blocked = tmp_path / "iPod_Control"
        blocked.write_text("a file where the directory should be")

        record = ledger.load(tmp_path, SERVER, 1)
        record.record(7, location=":a", track=TRACK, file_format="m4a", size=1)
        record.save()  # logs a warning, does not raise


class TestFingerprint:
    """The fallback identity, used when the ledger is missing or stale."""

    def test_case_and_punctuation_do_not_matter(self):
        """A tag written here and one written by iTunes differ in both."""
        assert ledger.fingerprint("Don't Stop", "The Band", "Album!") == ledger.fingerprint(
            "DONT STOP", "the band", "album"
        )

    def test_a_different_album_is_a_different_track(self):
        """The single and the album version are genuinely different files."""
        assert ledger.fingerprint("Song", "Artist", "Single") != ledger.fingerprint(
            "Song", "Artist", "Album"
        )

    def test_the_same_title_by_a_different_artist_does_not_collide(self):
        assert ledger.fingerprint("Halo", "A", "X") != ledger.fingerprint("Halo", "B", "X")
