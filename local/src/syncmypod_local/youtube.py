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

import contextlib
import logging
import os
import shutil
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


def sign_in(browser: str | None = None, *, prefer: str | None = None) -> Availability:
    """Find a browser signed in to YouTube and borrow its session.

    Nothing is typed here and no password is ever seen by this application.

    **No browser has to be named.** Every browser that can be read is tried in
    turn, and the first one holding a YouTube session wins. Asking the user
    which browser to use was asking them to know something they have no reason
    to know - most people are signed in to YouTube in one browser and could not
    say which of the seven listed it was. Trying them costs milliseconds each:
    a browser that is not installed fails immediately.

    A name can still be passed, which is what the command line does, and then
    only that one is tried. `prefer` reorders the attempts without narrowing
    them, and is how the window puts the browser it is being viewed in first.
    """
    if browser:
        chosen = browser.strip().lower()
        if chosen not in BROWSERS:
            raise YouTubeError(
                f"{browser!r} is not a browser this can read. Try one of: {', '.join(BROWSERS)}."
            )
        candidates = [chosen]
    else:
        candidates = list(BROWSERS)
        # The browser reading the page goes first. It is only a reordering -
        # every browser is still tried - but it is usually right, and being
        # right first means one cookie-database read instead of seven.
        if prefer:
            preferred = prefer.strip().lower()
            if preferred in candidates:
                candidates.remove(preferred)
                candidates.insert(0, preferred)

    from yt_dlp.cookies import extract_cookies_from_browser

    failures: list[str] = []
    for candidate in candidates:
        try:
            jar = extract_cookies_from_browser(candidate)
        except Exception as err:
            # Not installed, locked, or sealed. Worth remembering in case every
            # candidate fails, but not worth stopping for.
            failures.append(f"{candidate}: {_explain_extraction_failure(candidate, err)}")
            continue

        kept = _write_youtube_cookies(jar)
        if kept:
            logger.info("Kept %d youtube.com cookies from %s", kept, candidate)
            return check()
        failures.append(
            f"{candidate}: No YouTube cookies were found in {candidate}. Sign in to "
            "YouTube in that browser first, then try again."
        )

    raise YouTubeError(_explain_nothing_found(candidates, failures))


def _explain_nothing_found(candidates: list[str], failures: list[str]) -> str:
    """What actually happened, in the order the user can act on it.

    This used to return one fixed sentence saying no browser was signed in to
    YouTube, and to tell the user to sign in to Chrome or Edge. Both halves were
    wrong on the machine it was reported from: Chrome held 36 youtube.com
    cookies the whole time, and no amount of signing in to Chrome or Edge could
    ever have worked, because Windows Chromium seals its cookie values so that
    no other program can decrypt them.

    The reasons were being computed per browser and then thrown away, which is
    the part worth not repeating. A diagnosis that reaches nobody is not a
    diagnosis.
    """
    if len(candidates) == 1:
        if not failures:
            return "That browser could not be read."
        return _without_marks(failures[0].split(": ", 1)[-1])

    # Lead with a browser that could work if the user did something, rather than
    # with one that cannot work whatever they do.
    running = [f for f in failures if _LOCKED_MARK in f]
    sealed = [f for f in failures if _SEALED_MARK in f]

    lines = ["Could not borrow a YouTube session from any browser here."]
    if running:
        names = _and_list(sorted({f.split(":", 1)[0] for f in running}))
        verb = "is" if len(running) == 1 else "are"
        lines.append(
            f"{names} {verb} running, which locks the cookie database - close "
            "it completely and try again."
        )
    if sealed:
        names = _and_list(sorted({f.split(":", 1)[0] for f in sealed}))
        verb = "seals" if len(sealed) == 1 else "seal"
        lines.append(
            f"{names} {verb} every cookie value on this computer (App-Bound "
            "Encryption), which no other program can undo, closed or not."
        )
    lines.append(
        "Firefox is the one that works on Windows: sign in to YouTube there and "
        "press Sign in again. Or export a cookies.txt from any browser and use "
        "'Use a cookies.txt file' below."
    )
    return " ".join(lines)


def _and_list(names: list[str]) -> str:
    """``a``, ``a and b``, ``a, b and c`` - so the sentence reads as one."""
    if len(names) <= 1:
        return names[0] if names else ""
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _without_marks(text: str) -> str:
    """Strip the grouping markers before anything is shown."""
    for mark in (_LOCKED_MARK, _SEALED_MARK):
        text = text.replace(mark, "")
    return text.strip()


def import_cookies_file(source: str | Path) -> Availability:
    """Use a cookies.txt the user exported themselves.

    The route that works when reading the browser cannot. On Windows, Chromium
    seals its cookie values so no other program can decrypt them, and if Firefox
    is not installed there is otherwise nothing left to try - which is exactly
    the machine this was reported from. A file the user exports with a browser
    extension sidesteps the whole problem, because the browser does the
    decrypting.

    The same filtering applies as to a borrowed session: everything that is not
    a youtube.com cookie is dropped before anything is saved, so handing over a
    whole-jar export does not leave every other signed-in session on disk.
    """
    from yt_dlp.cookies import YoutubeDLCookieJar

    path = Path(str(source).strip().strip('"')).expanduser()
    if not path.is_file():
        raise YouTubeError(f"There is no file at {path}.")

    jar = YoutubeDLCookieJar(str(path))
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception as err:
        raise YouTubeError(
            f"{path.name} is not a cookies.txt file this can read ({err}). Export "
            "it in Netscape format - that is what every 'Get cookies.txt' "
            "extension produces."
        ) from err

    kept = _write_youtube_cookies(jar)
    if not kept:
        raise YouTubeError(
            f"{path.name} has no youtube.com cookies in it. Export it while you "
            "are on youtube.com and signed in, then try again."
        )

    logger.info("Kept %d youtube.com cookies from %s", kept, path.name)
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


# Markers carried on a per-browser failure so the summary can group them. They
# are not shown; only their presence is read.
_LOCKED_MARK = "[locked]"
_SEALED_MARK = "[sealed]"

CHROMIUM = frozenset({"chrome", "edge", "brave", "chromium", "opera", "vivaldi"})


def _chromium_cookies_are_sealed(browser: str) -> bool | None:
    """Whether this Chromium browser's cookie values can never be decrypted here.

    True, False, or None when it could not be established.

    Worth measuring rather than assuming. Chrome and Edge encrypt each cookie
    value with a version prefix: ``v10`` is the old scheme, which yt-dlp can
    unwrap, and ``v20`` is App-Bound Encryption, which it cannot - it falls
    through to DPAPI and DPAPI has no key for it. So a Chromium browser is a
    dead end or an ordinary locked file depending on a three-byte prefix, and
    the advice is opposite in the two cases: one is "close the browser", the
    other is "this will never work, use something else".

    Measured on the machine this was reported from: every one of Chrome's 961
    cookies was v20, so closing Chrome would have achieved nothing.
    """
    import sqlite3
    import sys
    import tempfile

    if sys.platform not in ("win32", "cygwin"):
        return False
    try:
        from yt_dlp.cookies import _get_chromium_based_browser_settings

        root = Path(_get_chromium_based_browser_settings(browser)["browser_dir"])
    except Exception:
        return None

    # The default profile is the one that matters; a per-profile answer would be
    # more precise and is not worth the complexity for a diagnostic.
    database = root / "Default" / "Network" / "Cookies"
    if not database.is_file():
        database = root / "Default" / "Cookies"
    if not database.is_file():
        return None

    copy = Path(tempfile.gettempdir()) / f"syncmypod-cookie-probe-{browser}.sqlite"
    try:
        # A running browser may hold the file open exclusively, which is the
        # other failure and is answered elsewhere.
        shutil.copyfile(database, copy)
        connection = sqlite3.connect(f"file:{copy}?mode=ro", uri=True)
        try:
            total, sealed = connection.execute(
                # hex() matters: encrypted_value is a BLOB, and SQLite never
                # compares a BLOB equal to a text literal, so the obvious
                # `substr(...) = 'v20'` is false for every row and every browser
                # comes back unsealed. 763230 is 'v20'.
                "SELECT count(*), "
                "sum(CASE WHEN hex(substr(encrypted_value, 1, 3)) = '763230' "
                "THEN 1 ELSE 0 END) "
                "FROM cookies"
            ).fetchone()
        finally:
            connection.close()
    except Exception:
        return None
    finally:
        with contextlib.suppress(OSError):
            copy.unlink()

    if not total:
        return None
    return (sealed or 0) >= total


def _explain_extraction_failure(browser: str, err: Exception) -> str:
    """Turn a cookie-database error into something actionable.

    The cases that actually happen have completely different fixes, and none of
    them is obvious from what the library raises.

    The one that was being misread: yt-dlp reports a locked cookie database as
    "Could not copy Chrome cookie database", with no word matching "locked" or
    "permission" in it. That fell through to the sealed-cookies branch, so a
    browser that merely needed closing was reported as one that could never
    work. It is an errno 13 PermissionError underneath.
    """
    text = str(err).lower()
    is_locked = (
        isinstance(err, PermissionError)
        or "could not copy" in text
        or "locked" in text
        or "permission" in text
        or "being used" in text
    )

    if "could not find" in text or "not found" in text or "no such file" in text:
        return (
            f"No {browser} profile was found on this computer. If {browser} is "
            "installed but signed in under a different profile, sign in to "
            "YouTube there first."
        )
    # A Chromium browser can fail for two reasons with opposite fixes, and the
    # message yt-dlp raises does not distinguish them. Look at the file.
    if browser in CHROMIUM and _chromium_cookies_are_sealed(browser):
        return (
            f"{_SEALED_MARK} {browser} seals every cookie value on this computer "
            "(App-Bound Encryption), so no other program can decrypt them - "
            "closing it would not help."
        )
    if is_locked:
        return (
            f"{_LOCKED_MARK} {browser}'s cookie database is locked, which means it "
            f"is running. Close {browser} completely and try again."
        )
    if browser in CHROMIUM:
        return (
            f"{_SEALED_MARK} Could not read cookies from {browser}: {err}. Chromium "
            "seals its cookies on Windows so another program cannot decrypt them."
        )
    return f"Could not read cookies from {browser}: {err}"
