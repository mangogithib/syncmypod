"""Device layer tests, run against simulated iPods.

These exercise the real pypodlib, not a mock. That is the point: the value of
this layer is that it correctly reads what the library reports, and a mock would
only assert that the code matches my assumptions about the library rather than
the library itself. pypodlib can simulate any model it knows, so the two devices
that actually matter here are both covered without hardware.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from syncmypod_local import device

FIXTURES = Path(__file__).parent / "fixtures"

# The two targets this project cares about, and the one difference between them
# that changes what the sync must do.
CLASSIC_7G = "MC297"  # iPod Classic 7th Gen 160GB - database must be signed
VIDEO_5G = "MA146"  # iPod 5th Gen 30GB - no signature


@pytest.fixture
def classic(tmp_path):
    return device.create_virtual(tmp_path / "classic", CLASSIC_7G, name="Test Classic")


@pytest.fixture
def video(tmp_path):
    return device.create_virtual(tmp_path / "video", VIDEO_5G, name="Test Video")


def test_classic_is_identified(classic):
    assert classic.model_number == CLASSIC_7G
    assert classic.generation == "7th Gen"
    assert "Classic" in (classic.model or "")
    assert classic.name == "Test Classic"
    assert classic.serial


def test_classic_requires_a_signature(classic):
    """The whole reason the two generations need different handling.

    Writing an unsigned database to a Classic leaves an iPod that boots to an
    empty library with every file still present, so this is the single most
    important fact the sync needs about a device.
    """
    assert classic.checksum_type == "HASH58"
    assert classic.needs_signature is True


def test_video_does_not_require_a_signature(video):
    assert video.model_number == VIDEO_5G
    assert video.checksum_type == "NONE"
    assert video.needs_signature is False


def test_capacity_and_free_space_are_numbers(classic):
    """`capacity` arrives from the library as a string like '160GB'.

    The server stores bytes, so a string reaching it would be silently dropped.
    Free space has to come from the filesystem - the library does not report it.
    """
    assert isinstance(classic.capacity_bytes, int)
    assert classic.capacity_bytes > 0
    assert isinstance(classic.free_bytes, int)


def test_report_matches_what_the_server_expects(classic):
    report = classic.as_report()
    assert set(report) == {
        "ipodName",
        "ipodModel",
        "ipodGeneration",
        "ipodSerial",
        "ipodCapacityBytes",
        "ipodFreeBytes",
        "ipodNeedsHash",
    }
    assert report["ipodNeedsHash"] is True
    assert report["ipodGeneration"] == "7th Gen"


def test_open_at_rejects_a_path_that_is_not_an_ipod(tmp_path):
    plain = tmp_path / "not-an-ipod"
    plain.mkdir()
    with pytest.raises(device.DeviceError, match="does not look like an iPod"):
        device.open_at(plain)


def test_open_at_rejects_a_missing_path(tmp_path):
    with pytest.raises(device.DeviceError, match="does not exist"):
        device.open_at(tmp_path / "nowhere")


def test_backup_returns_a_snapshot(classic):
    """A restore point before every write, since pypodlib is alpha."""
    snapshot = classic.backup(reason="test")
    assert snapshot


class TestCapacityParsing:
    """The string-to-bytes conversion, including the shapes that must not crash."""

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("160GB", 160 * 1024**3),
            ("30 GB", 30 * 1024**3),
            ("1TB", 1024**4),
            ("512MB", 512 * 1024**2),
            (64 * 1024**3, 64 * 1024**3),
        ],
    )
    def test_parses(self, value, expected):
        assert device._parse_capacity(value) == expected

    @pytest.mark.parametrize("value", [None, "", "unknown", "lots"])
    def test_unparseable_is_none_not_an_error(self, value):
        assert device._parse_capacity(value) is None


class TestChecksumNaming:
    def test_reads_an_enum(self):
        from pypodlib.device import ChecksumType

        assert device._checksum_name(ChecksumType.HASH58) == "HASH58"
        assert device._checksum_name(ChecksumType.NONE) == "NONE"

    def test_tolerates_a_plain_string(self):
        """Guards the alpha dependency changing this to a str in a later release."""
        assert device._checksum_name("hash72") == "HASH72"
        assert device._checksum_name("ChecksumType.HASH58") == "HASH58"

    def test_unknown_is_treated_as_needing_a_signature(self, tmp_path):
        """Erring towards signing, because the opposite mistake bricks the library view."""
        probe = device.IpodDevice(
            mount_path=tmp_path,
            name=None,
            model=None,
            model_number=None,
            generation=None,
            serial=None,
            capacity_bytes=None,
            free_bytes=None,
            checksum_type="UNKNOWN",
        )
        assert probe.needs_signature is True


class TestEject:
    """Making it safe to unplug.

    The moment after a sync is when an iPod gets pulled out of the socket, and
    it is the worst moment to do it: a freshly written database can still be in
    the operating system's write cache.
    """

    def test_a_simulated_device_is_never_handed_to_the_operating_system(self, classic):
        """A virtual iPod is an ordinary folder on a real disk.

        Passing one to an OS eject call could unmount whatever volume that
        folder happens to live on - which during a test run is the machine's
        own drive. pyPodLib recognises the simulation and declines; this asserts
        the behaviour rather than trusting it, because getting it wrong is not a
        failed test, it is a lost filesystem.
        """
        ok, message = classic.eject()
        assert ok
        assert "no operating-system eject" in message.lower()

    def test_a_volume_that_is_already_gone_counts_as_ejected(self, tmp_path, monkeypatch):
        """Windows ejects in two steps and can veto the second one.

        Seen on the real device: the volume had been flushed and unmounted, the
        hardware removal was vetoed by something holding a handle for an
        instant, and the tool reported a failure. What matters to the user is
        whether anything can still write to the iPod, so that is what is
        checked.
        """
        from pypodlib.device import eject as eject_module

        monkeypatch.setattr(
            eject_module, "eject_ipod", lambda *_a, **_k: (False, "Windows vetoed eject")
        )
        probe = device.IpodDevice(
            mount_path=tmp_path / "already-unmounted",
            name=None,
            model=None,
            model_number=None,
            generation=None,
            serial=None,
            capacity_bytes=None,
            free_bytes=None,
            checksum_type="NONE",
        )
        ok, message = probe.eject()
        assert ok
        assert "safe to unplug" in message.lower()

    def test_a_volume_that_is_still_mounted_reports_the_failure(self, tmp_path, monkeypatch):
        from pypodlib.device import eject as eject_module

        monkeypatch.setattr(
            eject_module, "eject_ipod", lambda *_a, **_k: (False, "Something has it open")
        )
        still_there = tmp_path / "mounted"
        still_there.mkdir()
        probe = device.IpodDevice(
            mount_path=still_there,
            name=None,
            model=None,
            model_number=None,
            generation=None,
            serial=None,
            capacity_bytes=None,
            free_bytes=None,
            checksum_type="NONE",
        )
        ok, message = probe.eject()
        assert not ok
        assert message == "Something has it open"

    def test_it_reports_rather_than_raises(self, tmp_path):
        probe = device.IpodDevice(
            mount_path=tmp_path / "nowhere",
            name=None,
            model=None,
            model_number=None,
            generation=None,
            serial=None,
            capacity_bytes=None,
            free_bytes=None,
            checksum_type="NONE",
        )
        ok, message = probe.eject()
        assert isinstance(ok, bool)
        assert message


class TestAnIpodWithNoDatabase:
    """A restored iPod that has never been synced.

    This is the state a 5.5th gen arrived in: every folder present, the
    pre-allocated ``iTunesControl`` in place, and no ``iTunesDB`` at all. The
    sync failed outright on it with "iTunesDB was not found", which is a dead
    end for anyone setting up a device they have just wiped.

    **Why no existing test caught it.** `create_virtual` is how every other test
    here gets a device, and a virtual iPod rebuilds its own database the moment
    it is connected - so the whole suite starts from a device that already has
    one and cannot reach this path by accident. The database is deleted below
    *after* the handle is open, which is the only way to hold a device in the
    state a real one arrives in.
    """

    @staticmethod
    def _itdb(pod):
        from pypodlib.device.info import resolve_itdb_path

        return resolve_itdb_path(str(pod.mount_path))

    @pytest.fixture
    def blank(self, video):
        """An open device whose database has been removed underneath it."""
        from pathlib import Path

        Path(self._itdb(video)).unlink()
        return video

    def test_a_virtual_ipod_rebuilds_its_database_on_connect(self, video, tmp_path):
        """The behaviour that hid the bug, asserted so it is not a surprise twice."""
        from pathlib import Path

        Path(self._itdb(video)).unlink()
        assert self._itdb(video) is None
        device.open_at(video.mount_path)
        assert self._itdb(video) is not None

    def test_the_missing_database_is_noticed(self, blank):
        assert blank.has_database is False

    def test_reading_it_says_empty_rather_than_failing(self, blank):
        # The old behaviour raised here, which is what stopped the sync before
        # it could get as far as creating anything.
        assert blank.tracks() == []
        assert blank.playlist_names() == []

    def test_one_is_created_on_demand(self, blank):
        assert blank.ensure_database() is True
        assert blank.has_database is True
        assert blank.tracks() == []

    def test_creating_one_twice_does_nothing(self, blank):
        assert blank.ensure_database() is True
        assert blank.ensure_database() is False

    def test_music_already_on_the_device_stops_it(self, blank):
        """The one case where an empty database would destroy something.

        Audio files with no database are already invisible to the iPod. Writing
        an empty database over them makes that permanent, and they are somebody
        else's music.
        """
        folder = blank.mount_path / "iPod_Control" / "Music" / "F00"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "ABCD.m4a").write_bytes(b"not really audio, but named like it")

        with pytest.raises(device.DeviceError, match="1 audio file"):
            blank.ensure_database()
        assert blank.has_database is False

    def test_counting_ignores_things_that_are_not_audio(self, video):
        music = video.mount_path / "iPod_Control" / "Music" / "F00"
        music.mkdir(parents=True, exist_ok=True)
        (music / "song.m4a").write_bytes(b"x")
        (music / "song.MP3").write_bytes(b"x")
        (music / "notes.txt").write_bytes(b"x")

        assert device._count_audio_files(video.mount_path) == 2


class TestPlaylistsReachTheDatasetTheIpodReads:
    """An iTunesDB carries its playlists twice, and only one of them counts.

    MHSD type 2 is the original playlist list; type 3 was added for the 5th
    generation and is what everything since reads. pypodlib's `create_playlist`
    appends only to type 2 - it calls type 3 "podcast playlists", which is what
    the field was first used for and not what it means now.

    The symptom is exact, and was reported as "the playlist is not on the iPod":
    the database holds it, `playlist_names()` lists it, all the music is there,
    and the device's Playlists menu is empty. Measured on the real 5.5th gen,
    MHSD 3 held one entry - the master - while MHSD 2 held three.
    """

    @staticmethod
    def datasets(pod):
        library = pod._handle.library()
        inner = getattr(library, "_library", library)
        return getattr(inner, "_ds2", []), getattr(inner, "_ds3", [])

    @staticmethod
    def names(rows):
        return [r.get("Title") for r in rows]

    def test_a_written_playlist_is_in_both_datasets(self, video, tmp_path):
        source = tmp_path / "song.m4a"
        source.write_bytes((FIXTURES / "tagged.m4a").read_bytes())
        landed = video.add_files([source])
        location = next(iter(landed.values()))

        video.write_playlists([("Road Trip", [location])])

        reopened = device.open_at(video.mount_path)
        ds2, ds3 = self.datasets(reopened)
        assert "Road Trip" in self.names(ds2)
        assert "Road Trip" in self.names(ds3), "the iPod reads dataset 3 and it is not there"

    def test_the_two_datasets_agree_on_the_tracks(self, video, tmp_path):
        sources = []
        for index in range(2):
            path = tmp_path / f"song{index}.m4a"
            path.write_bytes((FIXTURES / "tagged.m4a").read_bytes())
            sources.append(path)
        landed = video.add_files(sources)
        locations = list(landed.values())

        video.write_playlists([("Both", locations)])

        reopened = device.open_at(video.mount_path)
        ds2, ds3 = self.datasets(reopened)
        in_two = next(r for r in ds2 if r.get("Title") == "Both")
        in_three = next(r for r in ds3 if r.get("Title") == "Both")
        assert len(in_two["items"]) == len(locations)
        assert len(in_three["items"]) == len(in_two["items"])

    def test_rewriting_updates_dataset_three_rather_than_duplicating(self, video, tmp_path):
        source = tmp_path / "song.m4a"
        source.write_bytes((FIXTURES / "tagged.m4a").read_bytes())
        landed = video.add_files([source])
        location = next(iter(landed.values()))

        video.write_playlists([("Twice", [location])])
        video.write_playlists([("Twice", [location])])

        reopened = device.open_at(video.mount_path)
        _, ds3 = self.datasets(reopened)
        assert self.names(ds3).count("Twice") == 1
