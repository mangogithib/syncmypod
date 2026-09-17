"""Writing the server's metadata onto a downloaded file.

This is the module the whole architecture exists for.

Whatever a download source embedded in the file it handed over is discarded -
not merged, not used as a fallback - and replaced with the manifest's fields.
Source metadata is routinely wrong in ways that stay invisible until the iPod is
in your hand: several artists collapsed into one string, an album field holding
a channel name, a title that is really a video description. The server has
already resolved the truth against Deezer, iTunes and MusicBrainz, and that is
what goes on the device.

Two formats matter, because they are the two an iPod plays and the two a sync
can end up with: MP4/M4A (AAC, what a transcode produces and what YouTube's
best audio stream already is) and MP3.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from mutagen.id3 import (
    APIC,
    ID3,
    TALB,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TRCK,
    TSRC,
    TXXX,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

from . import __version__

logger = logging.getLogger(__name__)

# ID3v2.3 rather than the newer v2.4. Clickwheel iPods were built against v2.3,
# and while a Classic reads most of v2.4, the failure when it does not is a
# track showing as "Unknown" on the device with a perfectly good file behind it.
# Nothing in the manifest needs a frame v2.3 lacks, so the newer version buys
# nothing and risks that.
_ID3_VERSION = 3

# Cover art larger than this is a provider serving something unexpected. The
# iPod rescales to a few hundred pixels anyway, so nothing is lost by refusing.
_MAX_ARTWORK_BYTES = 4 * 1024 * 1024


class TaggingError(Exception):
    """The file could not be tagged, phrased for a user."""


@dataclass(slots=True)
class Artwork:
    """Cover art fetched from a provider CDN."""

    data: bytes
    mime: str

    @property
    def mp4_format(self) -> int:
        return MP4Cover.FORMAT_PNG if self.mime == "image/png" else MP4Cover.FORMAT_JPEG


def embedded_artwork(path: Path) -> Artwork | None:
    """The cover already in a file, so re-tagging can put it back.

    `apply` clears every tag before writing, which is the whole point of it -
    nothing a download source wrote survives. That is right when the artwork is
    being supplied alongside, and destructive when it is not: re-tagging a file
    already on an iPod would silently drop the cover embedded in it, and the
    artwork database is rebuilt by reading the covers back out of those very
    files. One pass of tag corrections would have quietly stripped the art off
    the device.

    Returns None for a file with no cover, an unreadable one, or a format
    without a picture frame. The caller treats all three the same way.
    """
    suffix = path.suffix.lower()
    try:
        if suffix in {".m4a", ".m4b", ".mp4", ".m4v"}:
            covers = MP4(path).tags.get("covr") if MP4(path).tags else None
            if not covers:
                return None
            cover = covers[0]
            mime = "image/png" if cover.imageformat == MP4Cover.FORMAT_PNG else "image/jpeg"
            return Artwork(data=bytes(cover), mime=mime)
        if suffix == ".mp3":
            tags = MP3(path, ID3=ID3).tags
            frames = tags.getall("APIC") if tags else []
            if not frames:
                return None
            return Artwork(data=frames[0].data, mime=frames[0].mime or "image/jpeg")
    except Exception:
        # A cover that cannot be read is not a reason to refuse to re-tag. The
        # file keeps its metadata correct and loses a picture the device holds
        # its own copy of.
        return None
    return None


def apply(path: Path, track: dict[str, Any], artwork: Artwork | None = None) -> None:
    """Replace every tag on *path* with the manifest's metadata.

    Dispatches on the file's real extension rather than on what the manifest
    expected, because the transcoder decides the output format and is allowed to
    disagree with the plan.
    """
    suffix = path.suffix.lower()
    if suffix in {".m4a", ".m4b", ".mp4", ".m4v"}:
        _apply_mp4(path, track, artwork)
    elif suffix == ".mp3":
        _apply_mp3(path, track, artwork)
    else:
        # Not fatal - the file still plays - but it arrives carrying whatever
        # the source called it, which is the thing this module exists to
        # prevent, so it is worth saying.
        logger.warning("No tag writer for %s - leaving %s untagged", suffix, path.name)


def fetch_artwork(url: str | None, client: httpx.Client | None = None) -> Artwork | None:
    """Download cover art, or None.

    Artwork is decoration: the manifest says the URL may 404, and a track
    without a picture is still a working track. Every failure here becomes a log
    line rather than a failed sync.
    """
    if not url:
        return None

    owns_client = client is None
    client = client or httpx.Client(timeout=20.0, follow_redirects=True)
    try:
        response = client.get(url, headers={"User-Agent": f"SyncMyPod-Local/{__version__}"})
        if response.status_code != 200:
            logger.info("Artwork unavailable (%s) at %s", response.status_code, url)
            return None
        data = response.content
        if not data or len(data) > _MAX_ARTWORK_BYTES:
            logger.info("Artwork skipped: %d bytes from %s", len(data), url)
            return None
        mime = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        if mime not in {"image/jpeg", "image/png"}:
            mime = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        return Artwork(data=data, mime=mime)
    except httpx.HTTPError as err:
        logger.info("Artwork download failed for %s: %s", url, err)
        return None
    finally:
        if owns_client:
            client.close()


# ---------------------------------------------------------------------------
# MP4 / M4A
# ---------------------------------------------------------------------------


def _apply_mp4(path: Path, track: dict[str, Any], artwork: Artwork | None) -> None:
    try:
        audio = MP4(path)
    except Exception as err:
        raise TaggingError(f"Could not open {path.name} as an MP4 file: {err}") from err

    # Everything the source wrote goes, including any artwork it embedded. A
    # partial overwrite would leave behind whatever fields the manifest happens
    # not to set - a source's composer, comment or grouping - on the device.
    # Cleared in memory rather than with delete(), which would write the file
    # once just to empty it and again to fill it back in.
    if audio.tags is None:
        audio.add_tags()
    audio.tags.clear()
    tags: dict[str, Any] = {}

    _set(tags, "\xa9nam", _text(track.get("title")))
    _set(tags, "\xa9ART", _text(track.get("artist")))
    _set(tags, "\xa9alb", _text(track.get("album")))
    _set(tags, "aART", _album_artist(track))
    _set(tags, "\xa9gen", _text(track.get("genre")))

    year = _int(track.get("year"))
    if year:
        _set(tags, "\xa9day", str(year))

    track_no = _int(track.get("trackNo"))
    if track_no:
        tags["trkn"] = [(track_no, _int(track.get("totalTracks")) or 0)]
    disc_no = _int(track.get("discNo"))
    if disc_no:
        tags["disk"] = [(disc_no, 0)]

    # The iPod draws its explicit badge from this: 0 none, 1 explicit, 2 clean.
    tags["rtng"] = [1 if track.get("explicit") else 0]
    # Without this, every album with a featured guest is filed as a compilation
    # and scatters across the Albums list on the device.
    tags["cpil"] = False

    isrc = _text(track.get("isrc"))
    if isrc:
        tags["----:com.apple.iTunes:ISRC"] = [isrc.encode("utf-8")]

    if artwork is not None:
        tags["covr"] = [MP4Cover(artwork.data, imageformat=artwork.mp4_format)]

    audio.update(tags)
    try:
        audio.save()
    except Exception as err:
        raise TaggingError(f"Could not write tags to {path.name}: {err}") from err


# ---------------------------------------------------------------------------
# MP3
# ---------------------------------------------------------------------------


def _album_artist(track: dict[str, Any]) -> str:
    """Who to file the album under, or nothing when there is no album.

    **An album artist without an album is the string an iPod groups by.**

    That is the whole reason this is a function. Both writers used to fall back
    to the track artist whenever the manifest carried no album artist, which is
    right for a record whose album artist simply was not recorded - one artist,
    one album, filed correctly.

    It is wrong for a track with no album at all. Those have nothing to group
    on but the album artist, so falling back to the track artist gave fourteen
    album-less songs fourteen different grouping keys, and Cover Flow drew a
    separate "Unknown Album" tile for each of them. Left empty they share one
    key and appear once, which is what iTunes itself does.
    """
    if not _text(track.get("album")):
        return ""
    return _text(track.get("albumArtist")) or _text(track.get("artist"))


def _apply_mp3(path: Path, track: dict[str, Any], artwork: Artwork | None) -> None:
    try:
        audio = MP3(path, ID3=ID3)
    except Exception as err:
        raise TaggingError(f"Could not open {path.name} as an MP3 file: {err}") from err

    if audio.tags is None:
        audio.add_tags()

    tags = audio.tags
    assert tags is not None
    # In memory, not on disk: delete() would rewrite the file just to empty it.
    tags.clear()

    _add(tags, TIT2, _text(track.get("title")))
    _add(tags, TPE1, _text(track.get("artist")))
    _add(tags, TALB, _text(track.get("album")))
    _add(tags, TPE2, _album_artist(track))
    _add(tags, TCON, _text(track.get("genre")))
    _add(tags, TSRC, _text(track.get("isrc")))

    year = _int(track.get("year"))
    if year:
        tags.add(TDRC(encoding=3, text=[str(year)]))

    track_no = _int(track.get("trackNo"))
    if track_no:
        total = _int(track.get("totalTracks"))
        tags.add(TRCK(encoding=3, text=[f"{track_no}/{total}" if total else str(track_no)]))
    disc_no = _int(track.get("discNo"))
    if disc_no:
        tags.add(TPOS(encoding=3, text=[str(disc_no)]))

    # No standard v2.3 frame for this and the iPod ignores it, but it keeps the
    # file self-describing if it is ever copied back off the device.
    if track.get("explicit"):
        tags.add(TXXX(encoding=3, desc="ITUNESADVISORY", text=["1"]))

    if artwork is not None:
        tags.add(
            APIC(
                encoding=3,
                mime=artwork.mime,
                type=3,  # front cover
                desc="Cover",
                data=artwork.data,
            )
        )

    try:
        # v1=0 strips any ID3v1 block at the end of the file. Mutagen keeps one
        # by default, and a source's v1 tag surviving would defeat the whole
        # point here for any player that prefers it.
        audio.save(v1=0, v2_version=_ID3_VERSION)
    except Exception as err:
        raise TaggingError(f"Could not write tags to {path.name}: {err}") from err


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _set(tags: dict[str, Any], key: str, value: str | None) -> None:
    if value:
        tags[key] = [value]


def _add(tags: Any, frame: Any, value: str | None) -> None:
    if value:
        tags.add(frame(encoding=3, text=[value]))


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None
