"""Tests for the rule the whole architecture exists to enforce.

The fixtures are real audio files deliberately tagged the way a download source
tags things: a title that is a video description, a channel name in the artist
field, a promotional comment. Every test here is ultimately the same assertion -
that none of it survives.
"""

from __future__ import annotations

import base64
import shutil
from pathlib import Path

import httpx
import pytest
import respx
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

from syncmypod_local import tagging

FIXTURES = Path(__file__).parent / "fixtures"

# A manifest track in the shape docs/LOCAL_APP_API.md specifies, including the
# multi-artist case that raw source metadata reliably destroys.
TRACK = {
    "id": 1,
    "title": "Second Sunrise",
    "artist": "Aurora Kane, Minor Waves",
    "album": "Longer Days",
    "albumArtist": "Aurora Kane",
    "trackNo": 4,
    "discNo": 1,
    "totalTracks": 11,
    "year": 2022,
    "genre": "Alternative",
    "isrc": "AA6Q72000047",
    "explicit": True,
    "artists": [
        {"name": "Aurora Kane", "role": "primary", "position": 0},
        {"name": "Minor Waves", "role": "featured", "position": 1},
    ],
}


@pytest.fixture
def mp3(tmp_path):
    return Path(shutil.copy(FIXTURES / "tagged.mp3", tmp_path / "track.mp3"))


@pytest.fixture
def m4a(tmp_path):
    return Path(shutil.copy(FIXTURES / "tagged.m4a", tmp_path / "track.m4a"))


class TestReTagging:
    """Correcting a file already on an iPod, without losing its cover.

    `apply` clears every tag before writing, which is what stops a download
    source's metadata surviving. It also means re-tagging with no artwork
    argument drops the embedded cover - and the iPod's artwork database is
    rebuilt by reading covers back out of those very files, so a pass of tag
    corrections would have stripped the art off the device.
    """

    # A 1x1 PNG, built rather than written out, so there are no escapes in this
    # file to get wrong.
    COVER = tagging.Artwork(
        data=base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        ),
        mime="image/png",
    )

    def test_a_cover_can_be_read_back_out_m4a(self, m4a):
        tagging.apply(m4a, TRACK, self.COVER)
        found = tagging.embedded_artwork(m4a)
        assert found is not None
        assert found.data == self.COVER.data
        assert found.mime == "image/png"

    def test_a_cover_can_be_read_back_out_mp3(self, mp3):
        tagging.apply(mp3, TRACK, self.COVER)
        found = tagging.embedded_artwork(mp3)
        assert found is not None
        assert found.data == self.COVER.data

    def test_a_file_with_no_cover_reports_none(self, m4a):
        tagging.apply(m4a, TRACK)
        assert tagging.embedded_artwork(m4a) is None

    def test_re_tagging_keeps_the_cover_it_had(self, m4a):
        """The round trip a sync makes when it corrects a track on the device."""
        tagging.apply(m4a, TRACK, self.COVER)

        kept = tagging.embedded_artwork(m4a)
        tagging.apply(m4a, {**TRACK, "artist": "Someone Else"}, kept)

        after = MP4(m4a)
        assert after["\xa9ART"] == ["Someone Else"], "the correction was written"
        assert bytes(after["covr"][0]) == self.COVER.data, "the cover survived"


class TestAlbumGrouping:
    """What an iPod groups a track by, which is the album and the album artist.

    Fourteen songs with no album turned into fourteen "Unknown Album" tiles in
    Cover Flow, because the album artist fell back to the track artist and that
    became the only thing left to group on. An album artist for a track that is
    on no album is a contradiction; written empty, they share one key.
    """

    def test_no_album_means_no_album_artist_m4a(self, m4a):
        tagging.apply(m4a, {**TRACK, "album": None, "albumArtist": None})
        tags = MP4(m4a)
        assert tags.get("\xa9alb") in (None, [""], [])
        assert tags.get("aART") in (None, [""], [])

    def test_no_album_means_no_album_artist_mp3(self, mp3):
        tagging.apply(mp3, {**TRACK, "album": None, "albumArtist": None})
        tags = MP3(mp3).tags
        assert "TALB" not in tags
        assert "TPE2" not in tags

    def test_an_album_with_no_album_artist_still_files_under_the_artist(self, m4a):
        """The case the fallback was written for, and it is still right.

        One artist, one album, and nothing recorded the album artist - filing
        it under the track artist is correct and is what keeps the record
        together on the device.
        """
        tagging.apply(m4a, {**TRACK, "albumArtist": None})
        tags = MP4(m4a)
        assert tags["\xa9alb"] == ["Longer Days"]
        assert tags["aART"] == ["Aurora Kane, Minor Waves"]

    def test_an_album_artist_is_written_when_the_manifest_has_one(self, m4a):
        tagging.apply(m4a, TRACK)
        assert MP4(m4a)["aART"] == ["Aurora Kane"]


class TestSourceMetadataIsDiscarded:
    """The central rule, asserted from both directions on both formats."""

    def test_mp3_source_tags_do_not_survive(self, mp3):
        before = MP3(mp3)
        assert "Official Video HD 4K" in str(before.tags)

        tagging.apply(mp3, TRACK)

        after = MP3(mp3)
        text = str(after.tags)
        for junk in ("Official Video HD 4K", "SomeChannel", "Free Music Archive", "Subscribe"):
            assert junk not in text, f"{junk!r} survived tagging"

    def test_mp4_source_tags_do_not_survive(self, m4a):
        before = MP4(m4a)
        assert before.tags["\xa9nam"] == ["Lyric Video"]

        tagging.apply(m4a, TRACK)

        after = MP4(m4a)
        assert after.tags["\xa9nam"] == ["Second Sunrise"]
        assert "\xa9cmt" not in after.tags

    def test_a_field_the_manifest_leaves_empty_is_cleared_not_kept(self, m4a):
        """A partial overwrite would leave the source's value behind.

        The genre here is the one that catches it: the fixture has one, the
        track does not, and a merge rather than a replace would ship the
        source's "Various" to the iPod.
        """
        track = {**TRACK, "genre": None}
        tagging.apply(m4a, track)
        assert "\xa9gen" not in MP4(m4a).tags


class TestMp4Fields:
    def test_writes_what_the_manifest_says(self, m4a):
        tagging.apply(m4a, TRACK)
        tags = MP4(m4a).tags

        assert tags["\xa9nam"] == ["Second Sunrise"]
        assert tags["\xa9ART"] == ["Aurora Kane, Minor Waves"]
        assert tags["\xa9alb"] == ["Longer Days"]
        assert tags["aART"] == ["Aurora Kane"]
        assert tags["\xa9day"] == ["2022"]
        assert tags["\xa9gen"] == ["Alternative"]
        assert tags["trkn"] == [(4, 11)]
        assert tags["disk"] == [(1, 0)]
        assert tags["rtng"] == [1]

    def test_album_artist_falls_back_to_the_artist_credit(self, m4a):
        """Without this, a track with no album artist is filed under nothing."""
        tagging.apply(m4a, {**TRACK, "albumArtist": None})
        assert MP4(m4a).tags["aART"] == ["Aurora Kane, Minor Waves"]

    def test_not_marked_as_a_compilation(self, m4a):
        """A featured guest must not scatter the album across the device.

        The iPod files anything with the compilation flag under Compilations, so
        one guest appearance would split an album in the Albums list.
        """
        tagging.apply(m4a, TRACK)
        assert MP4(m4a).tags["cpil"] is False

    def test_isrc_is_carried_through(self, m4a):
        """The identity the server resolves on, kept with the file."""
        tagging.apply(m4a, TRACK)
        assert MP4(m4a).tags["----:com.apple.iTunes:ISRC"] == [b"AA6Q72000047"]


class TestMp3Fields:
    def test_writes_what_the_manifest_says(self, mp3):
        tagging.apply(mp3, TRACK)
        tags = MP3(mp3).tags

        assert tags["TIT2"].text == ["Second Sunrise"]
        assert tags["TPE1"].text == ["Aurora Kane, Minor Waves"]
        assert tags["TALB"].text == ["Longer Days"]
        assert tags["TPE2"].text == ["Aurora Kane"]
        assert str(tags["TRCK"].text[0]) == "4/11"
        assert str(tags["TPOS"].text[0]) == "1"
        assert str(tags["TDRC"].text[0]) == "2022"
        assert tags["TSRC"].text == ["AA6Q72000047"]

    def test_written_as_id3v2_3(self, mp3):
        """v2.4 risks a Classic showing a perfectly good file as Unknown."""
        tagging.apply(mp3, TRACK)
        assert MP3(mp3).tags.version[:2] == (2, 3)

    def test_a_track_with_no_numbers_is_still_valid(self, mp3):
        """A single has no track number, disc number, year or total."""
        sparse = {"id": 2, "title": "Untitled", "artist": "Nobody", "album": "Nowhere"}
        tagging.apply(mp3, sparse)
        tags = MP3(mp3).tags
        assert tags["TIT2"].text == ["Untitled"]
        assert "TRCK" not in tags
        assert "TDRC" not in tags


class TestArtwork:
    IMAGE = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64

    @respx.mock
    def test_embedded_in_mp4(self, m4a):
        respx.get("https://cdn.example/cover.png").mock(
            return_value=httpx.Response(
                200, content=self.IMAGE, headers={"content-type": "image/png"}
            )
        )
        art = tagging.fetch_artwork("https://cdn.example/cover.png")
        assert art is not None

        tagging.apply(m4a, TRACK, art)
        assert bytes(MP4(m4a).tags["covr"][0]) == self.IMAGE

    @respx.mock
    def test_embedded_in_mp3(self, mp3):
        respx.get("https://cdn.example/cover.png").mock(
            return_value=httpx.Response(
                200, content=self.IMAGE, headers={"content-type": "image/png"}
            )
        )
        tagging.apply(mp3, TRACK, tagging.fetch_artwork("https://cdn.example/cover.png"))
        assert MP3(mp3).tags["APIC:Cover"].data == self.IMAGE

    @respx.mock
    def test_a_404_is_not_a_failure(self):
        """The manifest warns the CDN may 404. A track without a picture works."""
        respx.get("https://cdn.example/gone.jpg").mock(return_value=httpx.Response(404))
        assert tagging.fetch_artwork("https://cdn.example/gone.jpg") is None

    @respx.mock
    def test_a_network_error_is_not_a_failure(self):
        respx.get("https://cdn.example/cover.jpg").mock(side_effect=httpx.ConnectError("down"))
        assert tagging.fetch_artwork("https://cdn.example/cover.jpg") is None

    def test_no_url_is_not_a_failure(self):
        assert tagging.fetch_artwork(None) is None

    @respx.mock
    def test_an_implausibly_large_image_is_refused(self):
        """A provider serving something unexpected should not be embedded."""
        respx.get("https://cdn.example/huge.jpg").mock(
            return_value=httpx.Response(
                200, content=b"\xff" * (5 * 1024 * 1024), headers={"content-type": "image/jpeg"}
            )
        )
        assert tagging.fetch_artwork("https://cdn.example/huge.jpg") is None


def test_an_unknown_format_is_left_alone_rather_than_failing(tmp_path):
    """Better an untagged track than a failed sync over a format nobody expected."""
    odd = tmp_path / "track.flac"
    odd.write_bytes(b"fLaC" + b"\x00" * 64)
    tagging.apply(odd, TRACK)  # logs a warning, does not raise


def test_a_file_that_is_not_audio_reports_clearly(tmp_path):
    broken = tmp_path / "track.m4a"
    broken.write_bytes(b"this is not an mp4")
    with pytest.raises(tagging.TaggingError, match="Could not open"):
        tagging.apply(broken, TRACK)
