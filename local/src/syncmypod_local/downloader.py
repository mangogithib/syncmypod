"""Finding and fetching the audio for a manifest track.

The server deliberately holds no audio and hands over no download URL - only
resolved metadata and the search terms built from it. Turning those into a file
is this module's whole job.

Two things here are worth understanding before changing anything.

**Choosing the right result matters more than downloading it.** A search for a
well-known song returns the studio version, a live cut, a sped-up edit, three
lyric videos and someone's cover, and they all look similar in a result list.
The manifest carries the track's exact duration from the metadata provider,
which is the one signal that separates them reliably, and YouTube's
auto-generated "- Topic" channels are the official audio rather than a
re-upload. Both are weighted heavily below.

**The format chosen avoids work later.** YouTube offers the same audio as Opus
and as AAC. An iPod cannot play Opus, so taking the Opus stream means a
re-encode - a lossy source encoded lossily a second time. Asking for the AAC
stream first means the file is usually iPod-ready as downloaded and never gets
re-encoded at all.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import ffmpeg as ffmpeg_finder
from . import youtube

logger = logging.getLogger(__name__)

# How many search results to consider. Enough that the studio version is in
# there when the first hit is a lyric video, few enough that metadata extraction
# does not dominate the run time.
SEARCH_RESULTS = 6

# How many candidates to actually try downloading before giving up on a track.
# More than one because a result can be age restricted or region blocked; not
# many more, because past the third-best match the quality is not worth it.
DOWNLOAD_ATTEMPTS = 3

# A candidate whose length differs from the manifest's by more than this is a
# different recording - an extended mix, a live take, or an hour-long "full
# album" upload - regardless of how well its title matches.
MAX_DURATION_DRIFT_SECONDS = 12.0

# How much *longer* than the catalogue a result may be on a second pass.
#
# Deezer's duration is the release's; what YouTube has for many regional and
# independent artists is the official video, which carries an intro the release
# does not. That is a systematic offset rather than noise - measured on the ten
# tracks that failed the 13 September sync, the closest upload was 15, 25, 31
# and 39 seconds long, all of them the right recording and all rejected.
#
# Asymmetric on purpose. Longer is explainable: an intro, an outro, a few
# seconds of applause. Shorter is not - a shorter upload is a clip, a snippet or
# an edit, so the strict limit still applies below the catalogue's length.
RELAXED_LONGER_SECONDS = 40.0

# Words that mean "not the recording the library asked for". Checked against the
# candidate's title only when the manifest's own title does not contain them,
# so a track genuinely called "... (Live)" can still be found.
_DISQUALIFYING = (
    "live",
    "cover",
    "karaoke",
    "instrumental",
    "remix",
    "mashup",
    "reaction",
    "full album",
    "slowed",
    "reverb",
    "sped up",
    "nightcore",
    "8d audio",
    "loop",
    "extended",
)

_TOPIC_CHANNEL = re.compile(r"\s-\s*topic$", re.IGNORECASE)
_DECORATION = re.compile(r"[\(\[][^)\]]*[)\]]|feat\.?.*$|ft\.?.*$", re.IGNORECASE)
# Deleted rather than turned into a space: "Don't Stop" and "Dont Stop" are the
# same track, and a source will happily write either. Code points rather than
# literals, because the curly variants read as a backtick in most editors.
_APOSTROPHE_CHARS = "'`" + chr(0x2018) + chr(0x2019) + chr(0x02BC)
_APOSTROPHES = re.compile(f"[{re.escape(_APOSTROPHE_CHARS)}]")
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)


class DownloadError(Exception):
    """No usable audio was found, phrased for a user."""


@dataclass(slots=True)
class Download:
    """One downloaded file and where it came from."""

    path: Path
    source: str
    source_url: str
    duration_seconds: float | None
    bitrate_kbps: int | None

    @property
    def size_bytes(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0


@dataclass(slots=True)
class Candidate:
    """A search result, with the score that decided whether it was used."""

    url: str
    title: str
    uploader: str
    duration: float | None
    score: float
    reason: str
    # Whether the title *and* an artist were both found. The relaxed pass turns
    # the length rule down, so it leans entirely on these two: without them a
    # longer upload could be any song at all by anybody.
    title_matched: bool = False
    artist_matched: bool = False

    @property
    def confident(self) -> bool:
        return self.title_matched and self.artist_matched


def fetch(track: dict[str, Any], destination: Path) -> Download:
    """Find and download the audio for one manifest track.

    A user-supplied ``sourceHint`` short-circuits the search entirely: if
    someone has pasted the URL they want, second-guessing it would be rude and
    would usually be wrong.
    """
    hint = (track.get("sourceHint") or "").strip()
    if hint:
        logger.info("Using the source hint for %r", track.get("title"))
        return _download(hint, destination, source="source-hint")

    candidates = search(track)
    if not candidates:
        raise DownloadError(
            f"No audio could be found for {_describe(track)}. "
            "Paste a source URL for this track in the web interface to sync it."
        )

    # The best-scoring candidate is usually the right one, but "best match" and
    # "actually downloadable" are different questions: a result can be age
    # restricted, region blocked, or withdrawn between the search and the
    # download. Found on a real sync, where an age-gated video would have failed
    # a track that three other results could have satisfied.
    failures: list[str] = []
    for candidate in candidates[:DOWNLOAD_ATTEMPTS]:
        logger.info(
            "Trying %r by %r (%.0fs, score %.2f: %s)",
            candidate.title,
            candidate.uploader,
            candidate.duration or 0,
            candidate.score,
            candidate.reason,
        )
        try:
            return _download(candidate.url, destination, source="youtube")
        except DownloadError as err:
            logger.info("%s did not work: %s", candidate.url, err)
            failures.append(str(err))

    raise DownloadError(
        f"Could not download {_describe(track)} after {len(failures)} attempt(s). "
        f"Last reason: {failures[-1] if failures else 'unknown'}"
    )


def search(track: dict[str, Any]) -> list[Candidate]:
    """Rank search results for a track, best first.

    Two queries are tried. The plain "artist - title" is right almost always;
    the album-qualified one is the fallback for when a song shares its name with
    something more popular. Results are pooled and scored together rather than
    the second query being trusted only when the first returns nothing, because
    "returned something" and "returned the right thing" are different.
    """
    terms = track.get("searchTerms") or {}
    queries = [q for q in (terms.get("primary"), terms.get("withAlbum")) if q]
    if not queries:
        queries = [" - ".join(filter(None, [track.get("artist"), track.get("title")]))]

    seen: dict[str, Candidate] = {}
    raw_by_query: list[list[dict[str, Any]]] = []
    for index, query in enumerate(queries):
        entries = _search_raw(query)
        raw_by_query.append(entries)
        for entry in entries:
            url = entry.get("webpage_url") or entry.get("url") or ""
            if not url or url in seen:
                continue
            scored = _score(entry, track, url)
            if scored is not None:
                seen[url] = scored
        # The first query is usually enough. Only reach for the album-qualified
        # one when nothing convincing came back, to keep a sync from making two
        # searches per track for no reason.
        if index == 0 and any(c.score >= 0.75 for c in seen.values()):
            break

    if seen:
        return sorted(seen.values(), key=lambda c: c.score, reverse=True)

    # Nothing survived the strict pass. Try again allowing a result to run
    # longer than the catalogue says, but only where the title and an artist
    # both match and no barred word applies - so this widens the length rule and
    # nothing else. It can only ever turn a failure into a match; a track that
    # already had a candidate never reaches here.
    relaxed: dict[str, Candidate] = {}
    for entries in raw_by_query:
        for entry in entries:
            url = entry.get("webpage_url") or entry.get("url") or ""
            if not url or url in relaxed:
                continue
            scored = _score(entry, track, url, longer_allowance=RELAXED_LONGER_SECONDS)
            if scored is not None and scored.confident:
                relaxed[url] = scored
    if relaxed:
        logger.info("Nothing matched %s on length; accepting a longer upload", _describe(track))
    return sorted(relaxed.values(), key=lambda c: c.score, reverse=True)


def _search_raw(query: str) -> list[dict[str, Any]]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError as YtDlpError

    # ignoreerrors matters here and nowhere else. A search extracts every result
    # in the page, so one age-restricted or withdrawn video among six would
    # otherwise abort the whole search and lose the five good candidates with
    # it. On a download, an error is the answer and must not be swallowed.
    watcher = _YtDlpLogger()
    options = _base_options() | {
        "logger": watcher,
        "skip_download": True,
        "extract_flat": False,
        "ignoreerrors": True,
        # Signed in, a search sees what that account can see - which includes
        # anything age restricted, the single most common reason a track could
        # not be found at all.
        **youtube.cookie_options(),
    }
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(f"ytsearch{SEARCH_RESULTS}:{query}", download=False)
    except YtDlpError as err:
        logger.warning("Search failed for %r: %s", query, err)
        return []
    except Exception as err:  # pragma: no cover - yt-dlp raises broadly
        logger.warning("Search failed for %r: %s", query, err)
        return []

    found = [e for e in (info or {}).get("entries") or [] if e]
    if not found and watcher.blocked:
        raise BlockedError(
            "YouTube is asking this computer to prove it is not a robot, so "
            "nothing can be downloaded at the moment. Press Sign in to YouTube "
            "on this page - a signed-in session is not subject to this - and "
            "then run the sync again."
        )
    return found


def _download(url: str, destination: Path, *, source: str) -> Download:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError as YtDlpError

    destination.mkdir(parents=True, exist_ok=True)
    options = _base_options() | {
        # The best AAC available, and no setting to get in the way of that.
        #
        # AAC first because an iPod plays it untouched, so the common case needs
        # no re-encode at all. "best" within AAC because a signed-in Premium
        # account is offered 256kbps where everyone else gets 128 - the same
        # expression picks up whichever the account is entitled to. The
        # fallbacks run down to "whatever audio exists" rather than failing: a
        # track in the wrong format can be converted, a missing one cannot.
        "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
        "outtmpl": str(destination / "source.%(ext)s"),
        "noplaylist": True,
        "overwrites": True,
        # The saved YouTube session, when there is one. This is the whole
        # difference between 128kbps and 256kbps.
        **youtube.cookie_options(),
    }

    found = ffmpeg_finder.find()
    if found is not None:
        options["ffmpeg_location"] = str(found.directory)

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except YtDlpError as err:
        raise DownloadError(f"Download failed: {_clean(str(err))}") from err
    except Exception as err:  # pragma: no cover - yt-dlp raises broadly
        raise DownloadError(f"Download failed: {_clean(str(err))}") from err

    if not info:
        raise DownloadError(f"Nothing was downloaded from {url}")

    path = _downloaded_path(info, destination)
    if path is None:
        raise DownloadError(f"The download from {url} produced no file.")

    return Download(
        path=path,
        source=source,
        source_url=info.get("webpage_url") or url,
        duration_seconds=_float(info.get("duration")),
        bitrate_kbps=_bitrate(info),
    )


def _downloaded_path(info: dict[str, Any], destination: Path) -> Path | None:
    """Where the file actually landed.

    yt-dlp reports this in a few different places depending on whether a
    postprocessor ran, so its own answer is preferred and the directory is only
    scanned when it does not give one.
    """
    downloads = info.get("requested_downloads") or []
    for entry in downloads:
        for key in ("filepath", "_filename", "filename"):
            value = entry.get(key)
            if value and Path(value).is_file():
                return Path(value)

    for key in ("filepath", "_filename"):
        value = info.get(key)
        if value and Path(value).is_file():
            return Path(value)

    files = sorted(
        (p for p in destination.iterdir() if p.is_file() and p.suffix != ".part"),
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    return files[0] if files else None


def _base_options() -> dict[str, Any]:
    """Options common to searching and downloading.

    Quiet, because yt-dlp's own progress output would fight with the progress
    this application prints, and its warnings are already surfaced through the
    logger where they belong.
    """
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": _YtDlpLogger(),
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "nocheckcertificate": False,
        "geo_bypass": True,
    }


# What YouTube says when it has decided this machine is a robot. It stops
# serving *everything* - a search for "Queen - Bohemian Rhapsody" comes back
# with six of these and no results - so it must never be reported as the track
# being unfindable.
_BOT_CHECK = ("not a bot", "sign in to confirm")


class BlockedError(DownloadError):
    """YouTube refused to serve this machine at all."""


class _YtDlpLogger:
    """Routes yt-dlp's chatter into the application's log instead of stdout.

    Also watches for the bot check. A search runs with ``ignoreerrors``, so
    per-video failures are swallowed and the caller sees an empty result list -
    indistinguishable from "this track does not exist". Recording it here is
    what lets the difference be reported.
    """

    def __init__(self) -> None:
        self.blocked = False

    def _watch(self, message: str) -> None:
        lowered = message.lower()
        if any(marker in lowered for marker in _BOT_CHECK):
            self.blocked = True

    def debug(self, message: str) -> None:
        if not message.startswith("[debug]"):
            logger.debug("yt-dlp: %s", message)

    def info(self, message: str) -> None:
        logger.debug("yt-dlp: %s", message)

    def warning(self, message: str) -> None:
        self._watch(message)
        logger.debug("yt-dlp: %s", message)

    def error(self, message: str) -> None:
        self._watch(message)
        logger.warning("yt-dlp: %s", message)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def _score(
    entry: dict[str, Any],
    track: dict[str, Any],
    url: str,
    *,
    longer_allowance: float = 0.0,
) -> Candidate | None:
    """Rate one search result, or reject it outright.

    Returns None for a candidate that is disqualified rather than merely poor -
    a wrong duration or a barred word - so it can never win by default when
    everything else scores badly too.
    """
    title = str(entry.get("title") or "")
    uploader = str(entry.get("uploader") or entry.get("channel") or "")
    duration = _float(entry.get("duration"))

    wanted_title = str(track.get("title") or "")
    wanted_artist = str(track.get("artist") or "")
    wanted_seconds = _float(track.get("durationMs"))
    if wanted_seconds:
        wanted_seconds /= 1000.0

    reasons: list[str] = []
    score = 0.0

    # Duration. The strongest signal available and the only one that reliably
    # separates a studio take from a live one, so it both gates and scores.
    if wanted_seconds and duration:
        drift = abs(duration - wanted_seconds)
        # A result longer than the catalogue is allowed more room on the
        # relaxed pass; a shorter one never is.
        allowed = MAX_DURATION_DRIFT_SECONDS
        if duration > wanted_seconds:
            allowed = max(allowed, longer_allowance)
        if drift > allowed:
            return None
        score += 0.40 * (1.0 - min(drift / MAX_DURATION_DRIFT_SECONDS, 1.0))
        reasons.append(f"{drift:.0f}s off")
    elif wanted_seconds and not duration:
        # A result with no duration cannot be checked. Not fatal, but it loses
        # the points it would have earned.
        reasons.append("no duration")

    # A "- Topic" channel is YouTube's own auto-generated upload of the label's
    # audio. When one exists it is almost always the right answer.
    if _TOPIC_CHANNEL.search(uploader):
        score += 0.25
        reasons.append("topic channel")

    normalised_title = _normalise(title)
    title_matched = bool(
        _normalise(wanted_title) and _normalise(wanted_title) in normalised_title
    )
    if title_matched:
        score += 0.20
        reasons.append("title match")

    haystack = f"{normalised_title} {_normalise(uploader)}"
    artist_matched = False
    if wanted_artist:
        # Any one of the credited artists appearing is enough. The manifest
        # joins them into one string, but a source rarely names them all.
        parts = [_normalise(p) for p in re.split(r"[,&]| and ", wanted_artist) if p.strip()]
        artist_matched = any(p and p in haystack for p in parts)
        if artist_matched:
            score += 0.15
            reasons.append("artist match")

    barred = _barred_word(title, wanted_title)
    if barred:
        return None

    return Candidate(
        url=url,
        title=title,
        uploader=uploader,
        duration=duration,
        score=round(score, 4),
        reason=", ".join(reasons) or "no signals",
        title_matched=title_matched,
        artist_matched=artist_matched,
    )


def _barred_word(candidate_title: str, wanted_title: str) -> str | None:
    """A word that means this is a different recording, unless it was asked for.

    Checked against the manifest's own title first: a track actually called
    "Live at Leeds" must not be unfindable because "live" is on the list.
    """
    candidate = candidate_title.lower()
    wanted = wanted_title.lower()
    for word in _DISQUALIFYING:
        if word in candidate and word not in wanted:
            return word
    return None


def _normalise(value: str) -> str:
    """Lower-cased, decoration removed, punctuation dropped.

    The same treatment is applied to both sides of every comparison. The server
    learned this the hard way: stripping the query but not the candidate made
    a generic single beat the correct soundtrack version.
    """
    without_decoration = _DECORATION.sub(" ", value or "")
    without_apostrophes = _APOSTROPHES.sub("", without_decoration)
    return " ".join(_NON_WORD.sub(" ", without_apostrophes).lower().split())


def _describe(track: dict[str, Any]) -> str:
    return (
        f"{track.get('artist') or 'unknown artist'} - {track.get('title') or 'unknown title'}"
    )


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _bitrate(info: dict[str, Any]) -> int | None:
    for key in ("abr", "tbr"):
        value = _float(info.get(key))
        if value:
            return int(value)
    return None


def _clean(message: str) -> str:
    """yt-dlp prefixes its errors; the prefix means nothing to a user."""
    return re.sub(r"^ERROR:\s*", "", message.strip())
