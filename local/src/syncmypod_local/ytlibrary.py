"""Reading the signed-in YouTube account's own playlists and liked songs.

This exists so that following a YouTube Music library needs **nothing set up**.

The obvious way to read somebody's playlists from a web app is Google's OAuth
API, and that was built first. It works, but it puts the instance owner through
the Google Cloud console - create a project, enable an API, register a client,
add a redirect URI, add yourself as a test user - before the login button they
actually wanted exists at all. For a self-hosted tool with one user that is a
large amount of ceremony to reach a small feature.

The session needed is already here. The local app signs in to YouTube by
borrowing the browser's own cookies, so that downloads get the 256kbps stream a
Premium account is entitled to. Those same cookies can list the account's
playlists. So this reads the library locally, with a credential that never
leaves the machine, and hands the result to the server.

**What that trades away.** The server holds no YouTube credential, which is the
security win, but it also means the server cannot refresh the library on its
own - the sync happens when this application runs. That is when the iPod is
plugged in anyway, and the web UI keeps a button for asking on demand.

Only titles and identifiers are read here. Nothing is downloaded, and the
metadata still goes through the server's resolver, because a video title is not
metadata - see the metadata rule in HANDOVER.md.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from . import youtube

logger = logging.getLogger(__name__)

# YouTube's own identifiers for the two lists that are not ordinary playlists.
# `LL` is liked videos, which is where YouTube Music files a thumbs-up, and is
# the one most people mean by "my liked songs".
LIKED = "LL"
WATCH_LATER = "WL"

# Where the account's own playlists are listed. The feed URL works for the
# signed-in user without needing to know their channel id.
PLAYLISTS_FEED = "https://www.youtube.com/feed/playlists"

# A playlist that is not worth offering. Watch Later is a queue of videos rather
# than a music collection, and history is not a playlist at all.
_SKIP_IDS = frozenset({WATCH_LATER, "HL"})


class LibraryError(Exception):
    """Something the user can act on, rather than a traceback."""


@dataclass
class YouTubePlaylist:
    """One playlist in the account, without its contents."""

    youtube_id: str
    title: str
    item_count: int | None = None
    thumbnail_url: str | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "youtubeId": self.youtube_id,
            "title": self.title,
            "itemCount": self.item_count,
            "thumbnailUrl": self.thumbnail_url,
        }


@dataclass
class YouTubeEntry:
    """One video inside a playlist. A hint for the resolver, never metadata."""

    video_id: str
    title: str
    channel: str = ""
    duration_ms: int | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "videoId": self.video_id,
            "title": self.title,
            "channel": self.channel,
            "durationMs": self.duration_ms,
        }


@dataclass
class LibrarySnapshot:
    playlists: list[YouTubePlaylist] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def require_session() -> None:
    """Refuse early, with the sentence the user needs, rather than mid-read."""
    if not youtube.is_signed_in():
        raise LibraryError(
            "Sign in to YouTube first. The same sign-in that fetches higher-quality "
            "audio is what reads your playlists."
        )


def read_library(*, include_liked: bool = True) -> LibrarySnapshot:
    """List the account's playlists, and the liked songs alongside them.

    Contents are deliberately not fetched here. A library can be hundreds of
    playlists and tens of thousands of videos, and the user has not yet said
    which of them they want - so this is the cheap pass that fills the picker,
    and :func:`read_playlist` is called afterwards for the chosen few.
    """
    require_session()

    snapshot = LibrarySnapshot()

    if include_liked:
        try:
            liked = _describe(LIKED)
            snapshot.playlists.append(
                YouTubePlaylist(
                    youtube_id=LIKED,
                    # yt-dlp reports this as "Liked videos". In YouTube Music it
                    # is where liked songs go, and this is a music application,
                    # so it is named for what the user will be looking for.
                    title="Liked songs",
                    item_count=liked.get("playlist_count") or liked.get("count"),
                    thumbnail_url=_thumbnail(liked),
                )
            )
        except LibraryError as err:
            # An account with no likes is not an error worth stopping for, and
            # neither is one where YouTube declined this particular list.
            snapshot.warnings.append(f"Liked songs could not be read: {err}")

    try:
        snapshot.playlists.extend(_own_playlists())
    except LibraryError as err:
        snapshot.warnings.append(f"Your playlists could not be read: {err}")

    if not snapshot.playlists:
        raise LibraryError(
            "No playlists were found. Check that the browser you signed in with is "
            "signed in to the right YouTube account."
        )

    return snapshot


def read_playlist(youtube_id: str, *, max_tracks: int = 5000) -> list[YouTubeEntry]:
    """Everything in one playlist, in its own order."""
    require_session()

    url = (
        f"https://www.youtube.com/playlist?list={youtube_id}"
        if youtube_id != LIKED
        else f"https://www.youtube.com/playlist?list={LIKED}"
    )
    data = _extract(url, flat=True)

    entries: list[YouTubeEntry] = []
    for raw in data.get("entries") or []:
        entry = _shape_entry(raw)
        if entry is not None:
            entries.append(entry)
        if len(entries) >= max_tracks:
            break
    return entries


# ---------------------------------------------------------------------------
# yt-dlp
# ---------------------------------------------------------------------------


def _base_options(*, flat: bool) -> dict[str, Any]:
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Flat extraction reads the listing page only. Without it yt-dlp opens
        # every video in turn, which for a 2,000-track liked list is thousands
        # of requests and the surest way to be rate limited.
        "extract_flat": "in_playlist" if flat else False,
        # One bad entry - a deleted video, an age-gated one - must not take the
        # rest of the playlist with it. This is the same lesson the downloader
        # learned: ignoreerrors belongs on a listing, never on a download.
        "ignoreerrors": True,
    }
    options.update(youtube.cookie_options())
    return options


def _extract(url: str, *, flat: bool) -> dict[str, Any]:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_base_options(flat=flat)) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as err:  # yt-dlp raises a wide range of its own types
        raise LibraryError(_explain(err)) from err

    if not data:
        raise LibraryError(
            "YouTube returned nothing. The saved sign-in may have expired - sign in again."
        )
    return data


def _describe(youtube_id: str) -> dict[str, Any]:
    """A playlist's own details, without walking its contents."""
    import yt_dlp

    options = _base_options(flat=True)
    # Enough entries to confirm the list exists and to take a thumbnail from,
    # without paging through all of it.
    options["playlistend"] = 1

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            data = ydl.extract_info(
                f"https://www.youtube.com/playlist?list={youtube_id}", download=False
            )
    except Exception as err:
        raise LibraryError(_explain(err)) from err

    if not data:
        raise LibraryError("YouTube returned nothing for that list.")
    return data


def _own_playlists() -> list[YouTubePlaylist]:
    data = _extract(PLAYLISTS_FEED, flat=True)

    found: list[YouTubePlaylist] = []
    for raw in data.get("entries") or []:
        if not raw:
            continue
        # The feed is a page of playlists, so each entry is itself a playlist.
        # Some accounts nest them one level under a shelf, hence the recursion.
        found.extend(_playlists_from(raw))
    return found


def _playlists_from(node: dict[str, Any]) -> list[YouTubePlaylist]:
    if node.get("_type") == "playlist" and node.get("entries") and not node.get("id"):
        nested: list[YouTubePlaylist] = []
        for child in node["entries"]:
            if child:
                nested.extend(_playlists_from(child))
        return nested

    playlist_id = node.get("id") or ""
    if not playlist_id or playlist_id in _SKIP_IDS:
        return []
    # A channel or a video that wandered into the feed. Playlist ids are longer
    # than a video id and never eleven characters.
    if len(playlist_id) <= 11:
        return []

    title = (node.get("title") or "").strip()
    if not title:
        return []

    return [
        YouTubePlaylist(
            youtube_id=playlist_id,
            title=title,
            item_count=node.get("playlist_count"),
            thumbnail_url=_thumbnail(node),
        )
    ]


def _shape_entry(raw: dict[str, Any] | None) -> YouTubeEntry | None:
    if not raw:
        return None

    video_id = raw.get("id") or ""
    title = (raw.get("title") or "").strip()
    if not video_id or not title:
        return None
    # Videos removed or made private keep their place in a playlist under these
    # exact titles, with no other metadata. They are not songs.
    if title in {"[Deleted video]", "[Private video]", "Deleted video", "Private video"}:
        return None

    duration = raw.get("duration")
    return YouTubeEntry(
        video_id=video_id,
        title=title,
        # On a flat extraction the uploader is `channel`; `uploader` is filled
        # in only by a full extraction, so both are tried.
        channel=(raw.get("channel") or raw.get("uploader") or "").strip(),
        duration_ms=int(duration * 1000) if isinstance(duration, (int, float)) else None,
    )


def _thumbnail(node: dict[str, Any]) -> str | None:
    thumbnails = node.get("thumbnails") or []
    if not thumbnails:
        return node.get("thumbnail")
    # Middle of the range: the largest is often a 1280px banner, which is a
    # waste for a list row, and the smallest is unreadably small.
    chosen = thumbnails[len(thumbnails) // 2]
    return chosen.get("url") if isinstance(chosen, dict) else None


def _explain(err: Exception) -> str:
    """Turn yt-dlp's message into one the user can act on."""
    text = str(err)
    lowered = text.lower()

    if "sign in" in lowered or "login required" in lowered or "not a bot" in lowered:
        return (
            "YouTube asked this to sign in, so the saved session is no longer valid. "
            "Sign in to YouTube in your browser again, then re-connect it here."
        )
    if "private" in lowered:
        return "That list is private to an account this is not signed in as."
    if "http error 429" in lowered or "too many requests" in lowered:
        return "YouTube is rate limiting this machine. Wait a few minutes and try again."
    return text.strip() or "YouTube could not be read."
