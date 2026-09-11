"""Writing the iPod's own artwork database.

Album art lives in two places and both are needed. The file's tags are what a
computer reads; the device reads a separate database of pre-scaled images in
`iPod_Control/Artwork`. Art in the tags but not in that database is invisible on
the iPod's screen, which is indistinguishable from the feature not working - so
these tests assert the second one, which is the one that was missing.
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path

import httpx
import pytest
import respx

from helpers import CLASSIC_6G, SERVER, manifest, mock_server, track
from syncmypod_local import device, downloader, ledger, sync

FIXTURES = Path(__file__).parent / "fixtures"


def cover_png(size: int = 320) -> bytes:
    """A real image, generated rather than inlined.

    It has to survive being decoded and rescaled to several iPod sizes, so a
    hand-written stub PNG would not exercise the thing under test. Pillow is a
    dependency anyway - the artwork writer needs it.
    """
    from PIL import Image

    image = Image.new("RGB", (size, size), (200, 40, 60))
    for x in range(size // 2):
        for y in range(size // 2):
            image.putpixel((x, y), (30, 90, 200))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


PNG = cover_png()


@pytest.fixture
def ipod(tmp_path):
    return device.create_virtual(tmp_path / "ipod", CLASSIC_6G, name="Art Test")


@pytest.fixture
def paired():
    from syncmypod_local import config

    return config.Config(server_url=SERVER, token="smp_testtoken", device_name="Test PC")


@pytest.fixture
def audio_with_art(monkeypatch):
    """A download that lands a fixture file, and a CDN that serves a cover."""

    def fake_fetch(track_dict, destination):
        destination.mkdir(parents=True, exist_ok=True)
        landed = destination / "source.m4a"
        shutil.copy(FIXTURES / "tagged.m4a", landed)
        return downloader.Download(landed, "youtube", "https://example/x", 268.0, 128)

    monkeypatch.setattr(downloader, "fetch", fake_fetch)


def serve_artwork():
    respx.get("https://cdn.example/cover.png").mock(
        return_value=httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
    )


def artwork_dir(ipod) -> Path:
    return ipod.mount_path / "iPod_Control" / "Artwork"


def strip_artwork(ipod) -> None:
    """Return the device to having no artwork at all.

    Both halves are needed, and which half is not enough is worth recording.
    Clearing the database rows alone does not work: the parser re-links a track
    to its image from the ArtworkDB's own song ids, so a zeroed row heals itself
    on the next read. Deleting the artwork store alone does not work either:
    ``artwork_id_ref`` lives in the iTunesDB row and survives the images going.
    """
    handle = device.open_at(ipod.mount_path)._handle
    for row in handle.library().tracks:
        row["artwork_id_ref"] = 0
        row["artwork_count"] = 0
        row["artwork_size"] = 0
    handle.save()
    shutil.rmtree(artwork_dir(ipod), ignore_errors=True)


class TestTheDeviceDatabase:
    @respx.mock
    def test_a_sync_writes_it(self, ipod, paired, audio_with_art):
        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.artwork_linked == 1
        assert not report.artwork_error
        assert (artwork_dir(ipod) / "ArtworkDB").is_file()
        # The pixel data. Without an .ithmb the database points at nothing.
        assert list(artwork_dir(ipod).glob("*.ithmb"))

    @respx.mock
    def test_the_track_row_points_at_an_image(self, ipod, paired, audio_with_art):
        """The link is the whole point. Art on disk that nothing references is
        invisible on the device, which is exactly the state this fixed."""
        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))

        sync.run(paired, mount=str(ipod.mount_path))

        written = device.open_at(ipod.mount_path).tracks()[0]
        assert written.has_artwork
        assert written.artwork_id > 0

    @respx.mock
    def test_a_track_whose_cover_404s_still_syncs(self, ipod, paired, audio_with_art):
        """Artwork is decoration. The manifest warns the CDN may 404."""
        respx.get("https://cdn.example/gone.png").mock(return_value=httpx.Response(404))
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/gone.png")]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.synced == 1
        assert report.artwork_linked == 0
        assert not device.open_at(ipod.mount_path).tracks()[0].has_artwork


class TestRepairingAnExistingLibrary:
    """A library synced before artwork existed must pick it up without
    re-downloading every track. That is the case Mohamed is actually in."""

    @respx.mock
    def test_missing_art_counts_as_work_to_do(self, ipod, paired, audio_with_art):
        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))
        sync.run(paired, mount=str(ipod.mount_path))

        # Put the device back into the pre-artwork state. Zeroing the database
        # row is not enough and it is worth knowing why: the parser re-links a
        # track to its image from the ArtworkDB's own song ids, so a stale zero
        # heals itself. Only a device with no artwork store has no artwork -
        # which is exactly the state of one synced before this existed.
        strip_artwork(ipod)
        assert not device.open_at(ipod.mount_path).tracks()[0].has_artwork

        second = sync.run(paired, mount=str(ipod.mount_path))

        assert not second.plan.to_download, "re-downloaded a track that was already there"
        assert second.artwork_linked == 1
        assert device.open_at(ipod.mount_path).tracks()[0].has_artwork

    @respx.mock
    def test_a_fully_synced_library_with_art_does_nothing(self, ipod, paired, audio_with_art):
        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))
        sync.run(paired, mount=str(ipod.mount_path))

        second = sync.run(paired, mount=str(ipod.mount_path))
        assert second.plan.nothing_to_do
        assert second.artwork_linked == 0


class TestItLeavesOtherTracksAlone:
    @respx.mock
    def test_artwork_belonging_to_another_tool_is_not_rebuilt(
        self, ipod, paired, audio_with_art
    ):
        """The device may already hold artwork iTunes put there.

        pyPodLib converges the whole device, so handing it every track would
        re-encode art this tool never wrote - and clear it outright for a track
        whose file has no embedded cover but whose art came from somewhere else.
        Only the tracks this tool manages are passed.
        """
        stranger = ipod.mount_path / "iPod_Control" / "Music" / "F00" / "STRANGER.m4a"
        stranger.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURES / "tagged.m4a", stranger)
        handle = device.open_at(ipod.mount_path)._handle
        handle.add_tracks([str(stranger)], raise_on_error=True)

        # Give the stranger an artwork link nothing on disk backs up. If the
        # artwork step touched it, the link would be cleared.
        library = handle.library(reload=True)
        for row in library.tracks:
            row["artwork_id_ref"] = 4242
            row["artwork_count"] = 1
        handle.save()

        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))
        sync.run(paired, mount=str(ipod.mount_path))

        after = {t.title: t for t in device.open_at(ipod.mount_path).tracks()}
        assert len(after) == 2
        # Ours got a real image; theirs kept the reference it arrived with.
        assert after["Track 1"].artwork_id not in (0, 4242)
        assert after["Lyric Video"].artwork_id == 4242


class TestPlanning:
    @respx.mock
    def test_a_dry_run_reports_missing_art_without_writing(self, ipod, paired, audio_with_art):
        serve_artwork()
        mock_server(manifest(tracks=[track(1, artworkUrl="https://cdn.example/cover.png")]))
        sync.run(paired, mount=str(ipod.mount_path))

        strip_artwork(ipod)

        report = sync.run(paired, mount=str(ipod.mount_path), dry_run=True)
        assert len(report.plan.artwork_missing) == 1
        assert report.artwork_linked == 0
        assert not device.open_at(ipod.mount_path).tracks()[0].has_artwork

    @respx.mock
    def test_only_our_tracks_are_ever_counted_as_missing(self, ipod, paired, audio_with_art):
        """Somebody else's un-arted track is not this tool's problem to fix."""
        stranger = ipod.mount_path / "iPod_Control" / "Music" / "F00" / "STRANGER.m4a"
        stranger.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURES / "tagged.m4a", stranger)
        device.open_at(ipod.mount_path)._handle.add_tracks([str(stranger)], raise_on_error=True)

        mock_server(manifest(tracks=[]))
        report = sync.run(paired, mount=str(ipod.mount_path), dry_run=True)

        assert report.plan.artwork_missing == []


def test_the_ledger_is_what_decides_which_tracks_are_ours(tmp_path):
    """Guards the property the artwork step depends on."""
    record = ledger.load(tmp_path, SERVER, 1)
    record.record(1, location=":a", track={"title": "T"}, file_format="m4a", size=1)
    assert set(record.by_location()) == {":a"}
