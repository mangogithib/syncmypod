"""The stored settings, and what happens to values that are not settings.

The audio quality reaches pypodlib's encoder by name. A value that is not one
of the three would fall through to a default there rather than failing, so the
check belongs here - at the boundary where a hand-edited file, or one written
by a newer build, comes in.
"""

from __future__ import annotations

import json

from syncmypod_local import config as config_module


class TestAudioQuality:
    def test_the_default_is_high(self):
        assert config_module.Config().audio_quality == "high"
        assert config_module.DEFAULT_AUDIO_QUALITY == "high"

    def test_every_choice_survives_a_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        for quality in config_module.AUDIO_QUALITY_CHOICES:
            stored = config_module.Config(
                server_url="https://example.org", token="t", audio_quality=quality
            )
            config_module.save(stored)
            assert config_module.load().audio_quality == quality

    def test_an_unknown_value_falls_back_rather_than_being_passed_on(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        (tmp_path / "config.json").write_text(
            json.dumps(
                {"server_url": "https://example.org", "token": "t", "audio_quality": "lossless"}
            ),
            encoding="utf-8",
        )
        assert config_module.load().audio_quality == "high"

    def test_a_config_written_before_the_setting_existed_gets_the_default(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        (tmp_path / "config.json").write_text(
            json.dumps({"server_url": "https://example.org", "token": "t"}),
            encoding="utf-8",
        )
        loaded = config_module.load()
        assert loaded.audio_quality == "high"
        # Never checked, rather than checked and found wanting. The two mean
        # different things to the window: one greys Premium out with "sign in
        # to check", the other says the account does not have it.
        assert loaded.youtube_premium is None


class TestTheRememberedPremiumVerdict:
    def test_it_survives_a_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        stored = config_module.Config(server_url="https://example.org", token="t")
        stored.youtube_premium = True
        stored.youtube_checked_at = 1_700_000_000.0
        config_module.save(stored)

        loaded = config_module.load()
        assert loaded.youtube_premium is True
        assert loaded.youtube_checked_at == 1_700_000_000.0

    def test_a_nonsense_timestamp_does_not_break_loading(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        (tmp_path / "config.json").write_text(
            json.dumps(
                {"server_url": "https://e.org", "token": "t", "youtube_checked_at": "yesterday"}
            ),
            encoding="utf-8",
        )
        assert config_module.load().youtube_checked_at is None
