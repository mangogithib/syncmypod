"""Reading the signed-in account's playlists, and handing them to the server.

The value of this path is that it needs nothing set up - the YouTube session
saved for fetching audio is the same one that lists the library. So the tests
that matter are about what gets filtered out before anything reaches the server,
and about the order of the three-step handshake, which is what keeps a whole
account from being read to import two playlists.

Nothing here talks to YouTube. yt-dlp's output shapes are used directly, because
those shapes are the contract; a live call would test Google's uptime.
"""

from __future__ import annotations

import pytest

from syncmypod_local import ytlibrary, ytsync


@pytest.fixture
def signed_in(tmp_path, monkeypatch):
    """A saved session, without one existing on the machine running the tests."""
    monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(ytlibrary.youtube, "is_signed_in", lambda: True)
    monkeypatch.setattr(ytlibrary.youtube, "cookie_options", lambda: {"cookiefile": "x"})


class TestItRefusesEarly:
    def test_without_a_session_it_says_which_sign_in_is_meant(self, tmp_path, monkeypatch):
        """There are two YouTube sign-ins in this project and only one is here,
        so the message has to point at the right one."""
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        monkeypatch.setattr(ytlibrary.youtube, "is_signed_in", lambda: False)

        with pytest.raises(ytlibrary.LibraryError, match="Sign in to YouTube first"):
            ytlibrary.require_session()


class TestWhatNeverReachesTheServer:
    """A playlist is full of things that are not songs."""

    def test_a_deleted_video_is_dropped(self):
        """They keep their place in a playlist under exactly these titles, with
        no other metadata. Sent on, they would become library rows called
        'Deleted video'."""
        for title in ("Deleted video", "[Deleted video]", "Private video", "[Private video]"):
            assert ytlibrary._shape_entry({"id": "abc12345678", "title": title}) is None

    def test_an_entry_with_no_title_is_dropped(self):
        assert ytlibrary._shape_entry({"id": "abc12345678", "title": ""}) is None
        assert ytlibrary._shape_entry({"id": "abc12345678"}) is None

    def test_an_entry_with_no_id_is_dropped(self):
        assert ytlibrary._shape_entry({"title": "A song"}) is None

    def test_nothing_at_all_is_dropped(self):
        assert ytlibrary._shape_entry(None) is None

    def test_a_real_entry_survives_with_its_duration_in_milliseconds(self):
        entry = ytlibrary._shape_entry(
            {
                "id": "dQw4w9WgXcQ",
                "title": "Artist - Song",
                "channel": "Artist",
                "duration": 212,
            }
        )
        assert entry is not None
        assert entry.video_id == "dQw4w9WgXcQ"
        assert entry.duration_ms == 212_000

    def test_a_live_stream_with_no_duration_still_comes_through_as_none(self):
        """Unlike the scraped path, a flat extraction has no duration for some
        entries and that is not enough on its own to call it not-a-song. The
        server's resolver decides, and a missing duration simply scores lower."""
        entry = ytlibrary._shape_entry({"id": "abc12345678", "title": "Song"})
        assert entry is not None and entry.duration_ms is None

    def test_the_uploader_is_read_from_either_field(self):
        """`channel` on a flat extraction, `uploader` on a full one."""
        flat = ytlibrary._shape_entry({"id": "a" * 11, "title": "S", "channel": "Chan"})
        full = ytlibrary._shape_entry({"id": "a" * 11, "title": "S", "uploader": "Up"})
        assert flat.channel == "Chan"
        assert full.channel == "Up"


class TestWhichPlaylistsAreOffered:
    def test_watch_later_is_not_a_music_playlist(self):
        """It is a queue of videos, and following it would import whatever the
        user meant to watch later."""
        assert ytlibrary._playlists_from({"id": "WL", "title": "Watch Later"}) == []

    def test_history_is_not_a_playlist_at_all(self):
        assert ytlibrary._playlists_from({"id": "HL", "title": "History"}) == []

    def test_a_video_that_wandered_into_the_feed_is_ignored(self):
        """A video id is eleven characters; a playlist id never is."""
        assert ytlibrary._playlists_from({"id": "dQw4w9WgXcQ", "title": "A video"}) == []

    def test_an_untitled_entry_is_ignored(self):
        assert ytlibrary._playlists_from({"id": "PL" + "a" * 30, "title": ""}) == []

    def test_a_real_playlist_comes_through(self):
        found = ytlibrary._playlists_from(
            {"id": "PLabcdefghijklmno", "title": "Driving", "playlist_count": 42}
        )
        assert len(found) == 1
        assert found[0].youtube_id == "PLabcdefghijklmno"
        assert found[0].title == "Driving"
        assert found[0].item_count == 42

    def test_playlists_nested_in_a_shelf_are_found(self):
        """Some accounts return the feed one level deeper, grouped."""
        found = ytlibrary._playlists_from(
            {
                "_type": "playlist",
                "entries": [
                    {"id": "PLaaaaaaaaaaaaaaa", "title": "One"},
                    {"id": "PLbbbbbbbbbbbbbbb", "title": "Two"},
                ],
            }
        )
        assert [item.title for item in found] == ["One", "Two"]


class TestThumbnails:
    def test_the_middle_size_is_taken(self):
        """The largest is often a 1280px banner and the smallest is unreadable."""
        url = ytlibrary._thumbnail(
            {"thumbnails": [{"url": "tiny"}, {"url": "just-right"}, {"url": "huge"}]}
        )
        assert url == "just-right"

    def test_a_single_thumbnail_field_is_used_when_there_is_no_list(self):
        assert ytlibrary._thumbnail({"thumbnail": "only"}) == "only"

    def test_no_thumbnail_is_none_rather_than_a_crash(self):
        assert ytlibrary._thumbnail({}) is None


class TestErrorMessages:
    """yt-dlp's own wording is not something to show a user."""

    def test_an_expired_session_says_to_sign_in_again(self):
        message = ytlibrary._explain(Exception("ERROR: Sign in to confirm you're not a bot"))
        assert "no longer valid" in message

    def test_rate_limiting_says_to_wait(self):
        assert "Wait a few minutes" in ytlibrary._explain(Exception("HTTP Error 429"))

    def test_anything_unrecognised_is_passed_through_rather_than_swallowed(self):
        assert ytlibrary._explain(Exception("something new")) == "something new"


class TestReadingTheLibrary:
    def test_liked_songs_is_named_for_what_a_music_user_calls_it(self, signed_in, monkeypatch):
        """yt-dlp reports 'Liked videos'. This is a music application."""
        monkeypatch.setattr(
            ytlibrary, "_describe", lambda _id: {"playlist_count": 12, "thumbnails": []}
        )
        monkeypatch.setattr(ytlibrary, "_own_playlists", list)

        snapshot = ytlibrary.read_library()
        assert snapshot.playlists[0].title == "Liked songs"
        assert snapshot.playlists[0].youtube_id == ytlibrary.LIKED

    def test_an_unreadable_liked_list_warns_rather_than_stopping(self, signed_in, monkeypatch):
        """An account with no likes must still get its own playlists."""

        def boom(_id):
            raise ytlibrary.LibraryError("nope")

        monkeypatch.setattr(ytlibrary, "_describe", boom)
        monkeypatch.setattr(
            ytlibrary,
            "_own_playlists",
            lambda: [ytlibrary.YouTubePlaylist("PLaaaaaaaaaaaaaaa", "Driving")],
        )

        snapshot = ytlibrary.read_library()
        assert [item.title for item in snapshot.playlists] == ["Driving"]
        assert snapshot.warnings and "Liked songs" in snapshot.warnings[0]

    def test_finding_nothing_at_all_is_an_error_worth_raising(self, signed_in, monkeypatch):
        """Silently reporting an empty library looks like success and is not."""

        def boom(*_args):
            raise ytlibrary.LibraryError("nope")

        monkeypatch.setattr(ytlibrary, "_describe", boom)
        monkeypatch.setattr(ytlibrary, "_own_playlists", boom)

        with pytest.raises(ytlibrary.LibraryError, match="No playlists were found"):
            ytlibrary.read_library()


class FakeApi:
    """Records the three calls in order, so the handshake can be asserted."""

    def __init__(self, selected=()):
        self.selected = list(selected)
        self.pushed_lists = []
        self.pushed_playlists = []
        self.failing = set()

    def push_youtube_library(self, playlists):
        self.pushed_lists.append(playlists)
        return {"stored": len(playlists), "selected": self.selected}

    def selected_youtube_playlists(self):
        return [{"youtubeId": item, "title": f"Name of {item}"} for item in self.selected]

    def push_youtube_playlist(self, youtube_id, entries):
        if youtube_id in self.failing:
            from syncmypod_local.api import ApiError

            raise ApiError("server said no")
        self.pushed_playlists.append((youtube_id, entries))
        return {"jobId": 1, "total": len(entries)}


class TestThePush:
    """The three-step handshake, and why it is three steps."""

    @pytest.fixture(autouse=True)
    def library(self, monkeypatch):
        monkeypatch.setattr(
            ytlibrary,
            "read_library",
            lambda **_k: ytlibrary.LibrarySnapshot(
                playlists=[
                    ytlibrary.YouTubePlaylist("LL", "Liked songs", 3),
                    ytlibrary.YouTubePlaylist("PLaaaaaaaaaaaaaaa", "Driving", 2),
                ]
            ),
        )
        monkeypatch.setattr(
            ytlibrary,
            "read_playlist",
            lambda pid, **_k: [ytlibrary.YouTubeEntry(f"{pid}-1", "Artist - Song")],
        )

    def test_nothing_is_read_until_the_user_has_chosen(self):
        """The whole reason the handshake has a middle step. Reading every
        playlist to import two would walk an entire account."""
        api = FakeApi(selected=[])
        report = ytsync.push_library(api)

        assert report.playlists_found == 2
        assert report.needs_choosing
        assert api.pushed_playlists == [], "contents were read before anything was chosen"

    def test_only_the_chosen_playlists_are_read(self):
        api = FakeApi(selected=["PLaaaaaaaaaaaaaaa"])
        report = ytsync.push_library(api)

        assert [sent[0] for sent in api.pushed_playlists] == ["PLaaaaaaaaaaaaaaa"]
        assert report.tracks_sent == 1
        assert not report.needs_choosing

    def test_one_failing_playlist_does_not_lose_the_others(self):
        """A liked list can be enormous and occasionally rate limited where a
        small playlist succeeds seconds later."""
        api = FakeApi(selected=["LL", "PLaaaaaaaaaaaaaaa"])
        api.failing.add("LL")

        report = ytsync.push_library(api)

        assert [sent[0] for sent in api.pushed_playlists] == ["PLaaaaaaaaaaaaaaa"]
        assert report.tracks_sent == 1
        assert len(report.failures) == 1

    def test_progress_is_reported_before_each_slow_step(self):
        """A minute of silence looks like a hang."""
        messages = []
        ytsync.push_library(FakeApi(selected=["LL"]), on_progress=messages.append)
        assert any("Reading your YouTube playlists" in m for m in messages)
        assert any("Liked songs" in m or "Name of LL" in m for m in messages)


class TestTheReportReadsLikeASentence:
    def test_a_first_run_says_what_to_do_next(self):
        report = ytsync.LibraryReport(playlists_found=5, playlists_followed=0)
        assert report.needs_choosing
        assert "Choose which to follow" in report.describe()

    def test_a_normal_run_counts_what_happened(self):
        report = ytsync.LibraryReport(playlists_found=5, playlists_followed=1, tracks_sent=1)
        assert report.describe() == "1 playlist followed, 1 track sent."

    def test_failures_are_counted_rather_than_hidden(self):
        report = ytsync.LibraryReport(
            playlists_found=2, playlists_followed=2, tracks_sent=4, failures=["one broke"]
        )
        assert "1 failed" in report.describe()
