"""Signing in to YouTube for the 256kbps stream.

The assertion that matters most is not about bitrates. It is that a browser's
whole cookie jar - every site the user is signed into - does not end up in a
file on disk. Only youtube.com is kept, because that is all yt-dlp's YouTube
extractor ever asks the jar for.
"""

from __future__ import annotations

import http.cookiejar
import time

import pytest

from syncmypod_local import downloader, youtube


@pytest.fixture
def config_home(tmp_path, monkeypatch):
    monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
    return tmp_path


def cookie(name: str, domain: str, value: str = "secret"):
    """A cookie in the shape a browser's jar hands over."""
    return http.cookiejar.Cookie(
        version=0,
        name=name,
        value=value,
        port=None,
        port_specified=False,
        domain=domain,
        domain_specified=True,
        domain_initial_dot=domain.startswith("."),
        path="/",
        path_specified=True,
        secure=True,
        expires=int(time.time()) + 86400,
        discard=False,
        comment=None,
        comment_url=None,
        rest={},
        rfc2109=False,
    )


def jar_with(*cookies):
    from yt_dlp.cookies import YoutubeDLCookieJar

    jar = YoutubeDLCookieJar()
    for item in cookies:
        jar.set_cookie(item)
    return jar


class TestOnlyYouTubeCookiesAreKept:
    """The privacy property. A browser jar holds every signed-in session."""

    def test_other_sites_never_reach_the_file(self, config_home, monkeypatch):
        monkeypatch.setattr(
            youtube, "check", lambda: youtube.Availability(best_aac_kbps=130, signed_in=True)
        )
        monkeypatch.setattr(
            "yt_dlp.cookies.extract_cookies_from_browser",
            lambda *_a, **_k: jar_with(
                cookie("SID", ".youtube.com"),
                cookie("SESSION", ".mybank.example", "do-not-store-this"),
                cookie("li_at", ".linkedin.com"),
                cookie("sb", ".facebook.com"),
            ),
        )

        youtube.sign_in("firefox")

        written = youtube.cookies_path().read_text(encoding="utf-8")
        assert "youtube.com" in written
        for leaked in ("mybank.example", "linkedin.com", "facebook.com", "do-not-store-this"):
            assert leaked not in written, f"{leaked} was written to disk"

    def test_google_com_is_dropped_too(self, config_home, monkeypatch):
        """Not needed, and it is the difference between YouTube access and
        access to the whole Google account.

        yt-dlp's YouTube extractor asks the jar for cookies matching
        https://www.youtube.com and nothing else, so google.com never gets used.
        """
        monkeypatch.setattr(
            youtube, "check", lambda: youtube.Availability(best_aac_kbps=130, signed_in=True)
        )
        monkeypatch.setattr(
            "yt_dlp.cookies.extract_cookies_from_browser",
            lambda *_a, **_k: jar_with(
                cookie("SID", ".youtube.com"),
                cookie("SAPISID", ".google.com", "whole-account-access"),
            ),
        )

        youtube.sign_in("firefox")

        written = youtube.cookies_path().read_text(encoding="utf-8")
        assert "google.com" not in written
        assert "whole-account-access" not in written

    def test_a_jar_with_no_youtube_cookies_is_refused(self, config_home, monkeypatch):
        """Writing an empty session would look like success and then not work."""
        monkeypatch.setattr(
            "yt_dlp.cookies.extract_cookies_from_browser",
            lambda *_a, **_k: jar_with(cookie("sb", ".facebook.com")),
        )
        with pytest.raises(youtube.YouTubeError, match="No YouTube cookies"):
            youtube.sign_in("firefox")
        assert not youtube.cookies_path().exists()


class TestTheSavedSession:
    def test_nothing_is_saved_to_begin_with(self, config_home):
        assert not youtube.is_signed_in()
        assert youtube.cookie_options() == {}

    def test_a_saved_session_is_handed_to_yt_dlp(self, config_home, monkeypatch):
        monkeypatch.setattr(
            youtube, "check", lambda: youtube.Availability(best_aac_kbps=256, signed_in=True)
        )
        monkeypatch.setattr(
            "yt_dlp.cookies.extract_cookies_from_browser",
            lambda *_a, **_k: jar_with(cookie("SID", ".youtube.com")),
        )
        youtube.sign_in("firefox")

        assert youtube.is_signed_in()
        assert youtube.cookie_options() == {"cookiefile": str(youtube.cookies_path())}

    def test_signing_out_deletes_it(self, config_home, monkeypatch):
        monkeypatch.setattr(
            youtube, "check", lambda: youtube.Availability(best_aac_kbps=130, signed_in=True)
        )
        monkeypatch.setattr(
            "yt_dlp.cookies.extract_cookies_from_browser",
            lambda *_a, **_k: jar_with(cookie("SID", ".youtube.com")),
        )
        youtube.sign_in("firefox")

        assert youtube.forget()
        assert not youtube.is_signed_in()
        assert not youtube.forget(), "reported deleting something twice"

    def test_an_unknown_browser_is_refused_before_anything_is_read(self, config_home):
        with pytest.raises(youtube.YouTubeError, match="not a browser"):
            youtube.sign_in("netscape")

    def test_safari_is_not_offered_where_it_cannot_work(self):
        """yt-dlp refuses it outright off macOS, so offering it only ever
        produces an error the user cannot act on."""
        import sys

        if sys.platform == "darwin":
            assert "safari" in youtube.BROWSERS
        else:
            assert "safari" not in youtube.BROWSERS
        assert youtube.BROWSERS[0] == "firefox", "the one that works on Windows comes first"


class TestBrowserDetection:
    """Which browser is reading the page, so the form can default to it.

    The page cannot hand over its own YouTube session - a localhost page reading
    youtube.com's cookies is exactly what the same-origin policy prevents - so
    the browser must still be named. It should not have to be chosen.
    """

    def test_firefox(self):
        assert (
            youtube.browser_from_user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) "
                "Gecko/20100101 Firefox/121.0"
            )
            == "firefox"
        )

    def test_edge_is_not_mistaken_for_chrome(self):
        """Every Chromium browser also claims to be Chrome, so order matters."""
        assert (
            youtube.browser_from_user_agent(
                "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
            )
            == "edge"
        )

    def test_opera_is_not_mistaken_for_chrome(self):
        assert (
            youtube.browser_from_user_agent(
                "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 "
                "Safari/537.36 OPR/106.0.0.0"
            )
            == "opera"
        )

    def test_plain_chrome(self):
        assert (
            youtube.browser_from_user_agent(
                "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
            == "chrome"
        )

    def test_nothing_recognisable_is_none_rather_than_a_guess(self):
        """A wrong default is worse than none - it would read the wrong
        browser's cookie database and report no YouTube session."""
        assert youtube.browser_from_user_agent("") is None
        assert youtube.browser_from_user_agent("curl/8.4.0") is None

    def test_it_only_ever_names_a_browser_that_is_offered(self):
        for agent in (
            "Mozilla/5.0 Safari/537.36",
            "Mozilla/5.0 Firefox/121.0",
            "Mozilla/5.0 Chrome/120.0 Safari/537.36",
        ):
            detected = youtube.browser_from_user_agent(agent)
            assert detected is None or detected in youtube.BROWSERS


class TestReportingWhatWasObserved:
    """A signed-in account without Premium is indistinguishable from no account
    at all, so the bitrate is measured rather than the state asserted."""

    def test_premium_is_decided_by_the_bitrate_offered(self):
        assert youtube.Availability(best_aac_kbps=256, signed_in=True).premium
        assert not youtube.Availability(best_aac_kbps=130, signed_in=True).premium
        assert not youtube.Availability(best_aac_kbps=None, signed_in=True).premium

    def test_a_signed_in_account_without_premium_says_so(self):
        described = youtube.Availability(best_aac_kbps=130, signed_in=True).describe()
        assert "no Premium" in described

    def test_a_failed_check_says_it_failed_rather_than_claiming_a_number(self):
        described = youtube.Availability(
            best_aac_kbps=None, signed_in=True, error="network down"
        ).describe()
        assert "could not check" in described


class TestPickingTheStream:
    """AAC specifically, not "best audio"."""

    def test_the_highest_bitrate_aac_wins(self):
        entry = {
            "formats": [
                {"acodec": "mp4a.40.2", "vcodec": "none", "abr": 129},
                {"acodec": "mp4a.40.2", "vcodec": "none", "abr": 256},
                {"acodec": "mp4a.40.5", "vcodec": "none", "abr": 48},
            ]
        }
        assert youtube.best_aac_bitrate(entry) == 256

    def test_opus_is_ignored_however_high_it_looks(self):
        """An iPod cannot play Opus, so a higher Opus number is not better - it
        would be re-encoded and end up worse than the AAC it beat."""
        entry = {
            "formats": [
                {"acodec": "mp4a.40.2", "vcodec": "none", "abr": 129},
                {"acodec": "opus", "vcodec": "none", "abr": 160},
            ]
        }
        assert youtube.best_aac_bitrate(entry) == 129

    def test_video_streams_are_ignored(self):
        entry = {"formats": [{"acodec": "mp4a.40.2", "vcodec": "avc1", "abr": 384}]}
        assert youtube.best_aac_bitrate(entry) is None

    def test_no_audio_at_all_is_none_not_zero(self):
        assert youtube.best_aac_bitrate({"formats": []}) is None
        assert youtube.best_aac_bitrate({}) is None


def test_the_format_chain_takes_the_best_aac(config_home):
    """One expression covers both accounts.

    Signed out it resolves to the 128kbps stream; with Premium the same
    expression picks the 256kbps one, because both are m4a and it asks for the
    best. That is why there is no quality setting.
    """
    import inspect

    source = inspect.getsource(downloader._download)
    assert "bestaudio[ext=m4a]" in source
    assert "youtube.cookie_options()" in source
