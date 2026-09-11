"""Signing in to YouTube, so a Premium account can hand over better audio.

Signed out, YouTube offers one AAC stream at roughly 128kbps. A YouTube Music
Premium account is offered a second one at 256kbps, and it is the same recording
at twice the bitrate - which matters, because the iTunes Store sold music at
256kbps and an iPod Classic can play up to 320. Without this, everything this
tool writes is half the quality the hardware was built for.

There is no password to type and no API to call. YouTube decides what to offer
from the session cookies the request carries, so signing in means borrowing the
session from a browser the user has already signed in with, and keeping it.

Three things are done deliberately.

**Only youtube.com cookies are kept.** A browser's cookie jar holds every site
the user is signed into, and writing all of that to a file would be a serious
thing to do casually. yt-dlp's YouTube extractor reads cookies for
``https://www.youtube.com`` and nothing else, so everything other than that
domain is dropped before anything is written - including ``google.com``. The
saved file grants access to YouTube, not to a Google account.

**The file is still a credential.** It is written 0600 where the platform
supports it, and `forget()` deletes it.

**What is reported is what was observed.** "Signed in" is not a thing YouTube
answers directly, and a valid non-Premium session looks exactly like no session
at all. So rather than claiming a state, this probes what bitrate is actually
being offered and reports that, which is the number the user cares about.
"""

from __future__ import annotations

import logging
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from .config import config_dir

logger = logging.getLogger(__name__)

COOKIES_FILENAME = "youtube-cookies.txt"


def _browsers_here() -> tuple[str, ...]:
    """The browsers whose cookies can actually be read on this platform.

    Firefox is first because it is the one that reliably works on Windows:
    Chromium's cookie database is locked while the browser runs, and since
    Chrome 127 its cookies are sealed with App-Bound Encryption that another
    process cannot unwrap there at all.

    Safari is offered only on macOS. Elsewhere yt-dlp refuses it outright, and
    an option that can only ever produce an error is worse than no option.
    """
    import sys

    common = ("firefox", "chrome", "edge", "brave", "chromium", "opera", "vivaldi")
    return (*common, "safari") if sys.platform == "darwin" else common


BROWSERS = _browsers_here()

# Above this, the account is being offered the Premium stream. The real figure
# is 256; the threshold sits below it because reported bitrates are averages
# and drift by a few kbps either way.
PREMIUM_KBPS = 200

# Any result will do - this asks YouTube what it is willing to offer, not about
# a particular song. A search rather than a fixed video id, because a video id
# can be removed and then the check would fail for the wrong reason.
_PROBE_QUERY = "ytsearch1:music"


class YouTubeError(Exception):
    """Signing in failed, phrased for a user."""


@dataclass(frozen=True, slots=True)
class Availability:
    """What YouTube is currently willing to hand over."""

    best_aac_kbps: int | None
    signed_in: bool
    error: str | None = None

    @property
    def premium(self) -> bool:
        return bool(self.best_aac_kbps and self.best_aac_kbps >= PREMIUM_KBPS)

    def describe(self) -> str:
        if self.error:
            return f"could not check ({self.error})"
        if not self.best_aac_kbps:
            return "signed in" if self.signed_in else "not signed in"
        quality = f"{self.best_aac_kbps}kbps AAC"
        if self.premium:
            return f"{quality} (Premium)"
        return f"{quality}" + (
            " - signed in, but no Premium on this account" if self.signed_in else ""
        )


def browser_from_user_agent(user_agent: str) -> str | None:
    """Which browser is asking, so the sign-in form can default to it.

    The page cannot hand over its own YouTube session - a localhost page reading
    cookies belonging to youtube.com is exactly what the same-origin policy
    exists to prevent, and if it were possible here it would be possible from
    any site you visit. So the session is read from the browser's cookie
    database on disk instead, which means knowing which browser.

    Asking the request which one it came from turns that into a default rather
    than a question. It stays a default and not a decision: someone may browse
    in one browser and be signed in to YouTube in another.

    Order matters. Every Chromium browser also claims to be Chrome, so the
    specific ones have to be recognised first. Brave is deliberately absent -
    it strips its own identifier to resist fingerprinting, so it is
    indistinguishable from Chrome here, which is one more reason the control
    stays editable.
    """
    agent = (user_agent or "").lower()
    if not agent:
        return None

    for marker, browser in (
        ("edg/", "edge"),
        ("opr/", "opera"),
        ("vivaldi", "vivaldi"),
        ("firefox/", "firefox"),
        ("chromium/", "chromium"),
        ("chrome/", "chrome"),
        ("safari/", "safari"),
    ):
        if marker in agent and browser in BROWSERS:
            return browser
    return None


def cookies_path() -> Path:
    return config_dir() / COOKIES_FILENAME


def is_signed_in() -> bool:
    """Whether a session has been saved. Says nothing about it still working."""
    path = cookies_path()
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def cookie_options() -> dict[str, str]:
    """What to merge into yt-dlp's options so a download uses the session."""
    return {"cookiefile": str(cookies_path())} if is_signed_in() else {}


def sign_in(browser: str) -> Availability:
    """Borrow the YouTube session from *browser* and keep it.

    The browser must have been signed in to YouTube already. Nothing is typed
    here and no password is ever seen by this application.
    """
    chosen = (browser or "").strip().lower()
    if chosen not in BROWSERS:
        raise YouTubeError(
            f"{browser!r} is not a browser this can read. Try one of: {', '.join(BROWSERS)}."
        )

    from yt_dlp.cookies import extract_cookies_from_browser

    try:
        jar = extract_cookies_from_browser(chosen)
    except Exception as err:
        raise YouTubeError(_explain_extraction_failure(chosen, err)) from err

    kept = _write_youtube_cookies(jar)
    if not kept:
        raise YouTubeError(
            f"No YouTube cookies were found in {chosen}. Sign in to YouTube in that "
            "browser first, then try again."
        )

    logger.info("Kept %d youtube.com cookies from %s", kept, chosen)
    return check()


def forget() -> bool:
    """Delete the saved session. Returns whether there was one."""
    path = cookies_path()
    if not path.exists():
        return False
    path.unlink()
    return True


def check(timeout: float = 45.0) -> Availability:
    """Ask YouTube what it is willing to offer, and report the answer.

    Deliberately measures rather than asserts. A signed-in account without
    Premium is indistinguishable from no account at all as far as the cookies
    go, and the thing worth knowing is the bitrate either way.
    """
    from yt_dlp import YoutubeDL

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": timeout,
        "noprogress": True,
        "ignoreerrors": True,
    } | cookie_options()

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(_PROBE_QUERY, download=False)
    except Exception as err:
        return Availability(best_aac_kbps=None, signed_in=is_signed_in(), error=str(err)[:200])

    entries = (info or {}).get("entries") or []
    if not entries or not entries[0]:
        return Availability(
            best_aac_kbps=None,
            signed_in=is_signed_in(),
            error="YouTube returned no results to check against.",
        )

    return Availability(best_aac_kbps=best_aac_bitrate(entries[0]), signed_in=is_signed_in())


def best_aac_bitrate(entry: dict) -> int | None:
    """The highest-bitrate AAC audio stream in a yt-dlp result.

    AAC specifically, not "best audio": the Opus stream is often nominally
    higher but an iPod cannot play it, so it would have to be re-encoded and
    would end up worse than the AAC it was chosen over.
    """
    best = 0
    for candidate in entry.get("formats") or []:
        if candidate.get("vcodec") not in (None, "none"):
            continue
        codec = str(candidate.get("acodec") or "")
        if not codec.startswith("mp4a"):
            continue
        try:
            bitrate = float(candidate.get("abr") or 0)
        except (TypeError, ValueError):
            continue
        best = max(best, bitrate)
    return round(best) if best else None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _write_youtube_cookies(jar) -> int:
    """Save only the YouTube cookies, and only readable by this user.

    The filtering is the important part. yt-dlp's YouTube extractor asks the jar
    for cookies matching ``https://www.youtube.com``, so nothing else is ever
    used - and writing a browser's whole cookie jar to disk would hand every
    other signed-in session to anyone who reads the file.
    """
    from yt_dlp.cookies import YoutubeDLCookieJar

    path = cookies_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    filtered = YoutubeDLCookieJar()
    kept = 0
    for cookie in jar:
        domain = (cookie.domain or "").lstrip(".").lower()
        if domain == "youtube.com" or domain.endswith(".youtube.com"):
            filtered.set_cookie(cookie)
            kept += 1

    if not kept:
        return 0

    temp = path.with_suffix(".tmp")
    # ignore_discard and ignore_expires keep the session cookies, which are the
    # ones that carry the sign-in and which a plain save would drop.
    filtered.save(str(temp), ignore_discard=True, ignore_expires=True)
    if os.name != "nt":
        temp.chmod(stat.S_IRUSR | stat.S_IWUSR)
    temp.replace(path)
    return kept


def _explain_extraction_failure(browser: str, err: Exception) -> str:
    """Turn a cookie-database error into something actionable.

    The two that actually happen have completely different fixes, and neither
    is obvious from what the library raises.
    """
    text = str(err).lower()

    if "could not find" in text or "not found" in text or "no such file" in text:
        return (
            f"No {browser} profile was found on this computer. If {browser} is "
            "installed but signed in under a different profile, sign in to "
            "YouTube there first."
        )
    if "locked" in text or "permission" in text or "being used" in text:
        return (
            f"{browser}'s cookie database is locked, which usually means it is "
            f"running. Close {browser} completely and try again."
        )
    if browser in {"chrome", "edge", "brave", "chromium", "opera", "vivaldi"}:
        return (
            f"Could not read cookies from {browser}: {err}. Recent Chromium "
            "versions seal their cookies so another program cannot read them. "
            "Firefox works reliably - sign in to YouTube there and use it "
            "instead."
        )
    return f"Could not read cookies from {browser}: {err}"
