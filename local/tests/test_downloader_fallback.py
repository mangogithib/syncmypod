"""Falling back when the best match cannot actually be downloaded.

Found on a real sync: one search result was age restricted, and yt-dlp's error
would have failed the track even though three other results would have served
it. "Best match" and "downloadable" are different questions.
"""

from __future__ import annotations

import pytest

from syncmypod_local import downloader

TRACK = {
    "id": 1,
    "title": "Second Sunrise",
    "artist": "Aurora Kane",
    "durationMs": 268000,
    "searchTerms": {"primary": "Aurora Kane - Second Sunrise"},
}


def candidates(*urls):
    return [
        downloader.Candidate(
            url=url, title="t", uploader="u", duration=268.0, score=s, reason=""
        )
        for s, url in zip(range(len(urls), 0, -1), urls, strict=True)
    ]


def test_the_next_candidate_is_tried_when_the_first_is_blocked(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "search", lambda _t: candidates("first", "second"))
    attempted = []

    def flaky(url, destination, *, source):
        attempted.append(url)
        if url == "first":
            raise downloader.DownloadError("Sign in to confirm your age")
        return downloader.Download(tmp_path / "ok.m4a", source, url, 268.0, 128)

    monkeypatch.setattr(downloader, "_download", flaky)

    result = downloader.fetch(TRACK, tmp_path)
    assert attempted == ["first", "second"]
    assert result.source_url == "second"


def test_it_gives_up_rather_than_working_through_every_result(monkeypatch, tmp_path):
    """Past the third-best match the recording is probably not the right one."""
    monkeypatch.setattr(downloader, "search", lambda _t: candidates("a", "b", "c", "d", "e"))
    attempted = []

    def always_fails(url, destination, *, source):
        attempted.append(url)
        raise downloader.DownloadError("blocked")

    monkeypatch.setattr(downloader, "_download", always_fails)

    with pytest.raises(downloader.DownloadError, match="after 3 attempt"):
        downloader.fetch(TRACK, tmp_path)
    assert attempted == ["a", "b", "c"]


def test_a_source_hint_is_not_second_guessed(monkeypatch, tmp_path):
    """A pasted URL is a decision, not a suggestion. No search, no fallback."""
    monkeypatch.setattr(
        downloader, "search", lambda _t: pytest.fail("searched despite a source hint")
    )
    monkeypatch.setattr(
        downloader,
        "_download",
        lambda url, destination, *, source: downloader.Download(
            tmp_path / "ok.m4a", source, url, 268.0, 128
        ),
    )

    result = downloader.fetch({**TRACK, "sourceHint": "https://example/exact"}, tmp_path)
    assert result.source == "source-hint"
    assert result.source_url == "https://example/exact"


def test_no_candidates_at_all_says_what_to_do_about_it(monkeypatch, tmp_path):
    monkeypatch.setattr(downloader, "search", lambda _t: [])
    with pytest.raises(downloader.DownloadError, match="Paste a source URL"):
        downloader.fetch(TRACK, tmp_path)
