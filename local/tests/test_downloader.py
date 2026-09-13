"""Search-result scoring.

No network. Picking the right result is the part that decides whether the iPod
ends up with the studio recording or someone's phone video of a concert, and it
is pure logic over a dict, so it is worth testing exhaustively and cheap to.
"""

from __future__ import annotations

import pytest

from syncmypod_local import downloader

TRACK = {
    "id": 1,
    "title": "Second Sunrise",
    "artist": "Aurora Kane",
    "album": "Longer Days",
    "durationMs": 268000,  # 4:28
}


def entry(**overrides):
    base = {
        "title": "Aurora Kane - Second Sunrise",
        "uploader": "Aurora Kane - Topic",
        "duration": 268.0,
        "webpage_url": "https://example/watch?v=good",
    }
    return base | overrides


def score(**overrides):
    candidate = downloader._score(entry(**overrides), TRACK, "https://example/x")
    return candidate.score if candidate else None


class TestDuration:
    """The strongest signal, and the only one that separates a live cut."""

    def test_an_exact_match_scores_highest(self):
        assert score(duration=268.0) > score(duration=274.0)

    def test_a_wildly_different_length_is_rejected_outright(self):
        """A 50-minute "full album" upload must never be a candidate."""
        assert score(duration=3000.0) is None

    def test_a_slightly_different_length_is_still_allowed(self):
        """Sources differ by a second or two over where a track ends."""
        assert score(duration=270.0) is not None

    def test_a_result_with_no_duration_is_allowed_but_scores_lower(self):
        assert score(duration=None) is not None
        assert score(duration=None) < score(duration=268.0)


class TestDisqualifyingWords:
    @pytest.mark.parametrize(
        "title",
        [
            "Second Sunrise (Live at Wembley)",
            "Second Sunrise - Cover by Someone",
            "Second Sunrise (Karaoke Version)",
            "Second Sunrise [slowed + reverb]",
            "Second Sunrise (Remix)",
            "Aurora Kane - Full Album",
        ],
    )
    def test_a_different_recording_is_rejected(self, title):
        assert score(title=title) is None

    def test_unless_the_library_asked_for_it(self):
        """A track genuinely called "... (Live)" must still be findable.

        The word is only barred when the manifest's own title does not have it,
        or an album of live recordings could never be synced at all.
        """
        live_track = {**TRACK, "title": "Second Sunrise (Live)"}
        candidate = downloader._score(
            entry(title="Aurora Kane - Second Sunrise (Live)"), live_track, "https://example/x"
        )
        assert candidate is not None


class TestSignals:
    def test_a_topic_channel_wins_over_a_reupload(self):
        """YouTube's auto-generated channels carry the label's own audio."""
        official = score(uploader="Aurora Kane - Topic")
        reupload = score(uploader="MusicVault2011")
        assert official > reupload

    def test_the_artist_being_named_anywhere_counts(self):
        named = score(title="Second Sunrise", uploader="Aurora Kane")
        anonymous = score(title="Second Sunrise", uploader="uploads4u")
        assert named > anonymous

    def test_one_of_several_credited_artists_is_enough(self):
        """The manifest joins every artist; a source names one if you are lucky."""
        track = {**TRACK, "artist": "Aurora Kane, Minor Waves"}
        candidate = downloader._score(
            entry(title="Minor Waves - Second Sunrise", uploader="whoever"), track, "u"
        )
        assert "artist match" in candidate.reason

    def test_decorations_do_not_stop_a_title_matching(self):
        """The bug the server hit: strip both sides, or neither matches."""
        track = {**TRACK, "title": "Second Sunrise"}
        candidate = downloader._score(
            entry(title='Second Sunrise (From "Longer Days")'), track, "u"
        )
        assert "title match" in candidate.reason


class TestRanking:
    def test_the_best_candidate_sorts_first(self):
        results = [
            downloader._score(entry(uploader="randomuser", duration=262.0), TRACK, "a"),
            downloader._score(
                entry(uploader="Aurora Kane - Topic", duration=268.0), TRACK, "b"
            ),
            downloader._score(entry(uploader="another", duration=265.0), TRACK, "c"),
        ]
        ranked = sorted([r for r in results if r], key=lambda c: c.score, reverse=True)
        assert ranked[0].url == "b"


class TestNormalising:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ('Kesariya (From "Brahmastra")', "kesariya"),
            ("Song Title [Official Video]", "song title"),
            ("Artist feat. Someone", "artist"),
            ("Artist ft. Someone", "artist"),
            ("  Mixed   Case  ", "mixed case"),
        ],
    )
    def test_strips_decoration_and_punctuation(self, raw, expected):
        assert downloader._normalise(raw) == expected


class TestAcceptingALongerUpload:
    """The relaxed second pass, added 13 September.

    Deezer's duration is the release's. For many regional and independent
    artists what YouTube has is the official *video*, which carries an intro the
    release does not - measured on ten real failures, the closest upload was 15,
    25, 31 and 39 seconds longer, every one the right recording and every one
    rejected by the 12-second rule.

    So a second pass allows longer, never shorter, and leans entirely on the
    title and artist to make up for the length signal it gave up.
    """

    @staticmethod
    def entry(title, uploader, duration, url="https://y/1"):
        return {"title": title, "uploader": uploader, "duration": duration, "webpage_url": url}

    @staticmethod
    def wanted(**over):
        base = {
            "id": 1,
            "title": "Dooron Dooron",
            "artist": "Paresh Pahuja",
            "durationMs": 215000,
        }
        return base | over

    def search_over(self, monkeypatch, entries):
        monkeypatch.setattr(downloader, "_search_raw", lambda _q: entries)
        return downloader.search(self.wanted())

    def test_the_strict_pass_still_wins_when_it_can(self, monkeypatch):
        """A tight match must not be passed over for a longer one."""
        found = self.search_over(
            monkeypatch,
            [
                self.entry(
                    "Dooron Dooron - Paresh Pahuja", "Label - Topic", 217, "https://y/exact"
                ),
                self.entry(
                    "Dooron Dooron (Official Video) - Paresh Pahuja", "P", 246, "https://y/long"
                ),
            ],
        )
        assert found[0].url == "https://y/exact"

    def test_a_longer_official_video_is_taken_when_nothing_else_fits(self, monkeypatch):
        found = self.search_over(
            monkeypatch,
            [
                self.entry(
                    "Dooron Dooron (Official Video) - Paresh Pahuja", "Paresh Pahuja", 246
                )
            ],
        )
        assert len(found) == 1
        assert found[0].duration == 246

    def test_forty_seconds_is_the_limit(self, monkeypatch):
        assert downloader.RELAXED_LONGER_SECONDS == 40.0
        found = self.search_over(
            monkeypatch,
            [self.entry("Dooron Dooron - Paresh Pahuja", "Paresh Pahuja", 215 + 41)],
        )
        assert found == []

    def test_shorter_is_never_relaxed(self, monkeypatch):
        """A shorter upload is a clip or an edit, not the track with an intro."""
        found = self.search_over(
            monkeypatch,
            [self.entry("Dooron Dooron - Paresh Pahuja", "Paresh Pahuja", 215 - 30)],
        )
        assert found == []

    def test_a_longer_result_still_needs_the_title_and_the_artist(self, monkeypatch):
        """Without the length signal these are all that is left."""
        no_artist = self.search_over(
            monkeypatch, [self.entry("Dooron Dooron (Video)", "Some Random Channel", 246)]
        )
        assert no_artist == []

        wrong_title = self.search_over(
            monkeypatch, [self.entry("A Different Song", "Paresh Pahuja", 246)]
        )
        assert wrong_title == []

    def test_a_barred_word_is_still_barred(self, monkeypatch):
        """The relaxed pass widens the length rule and nothing else."""
        found = self.search_over(
            monkeypatch,
            [self.entry("Dooron Dooron (Live) - Paresh Pahuja", "Paresh Pahuja", 246)],
        )
        assert found == []
