"""Audio quality settings.

The assertion that matters most is the one about not inflating a file. A
quality menu that lets someone pick 256kbps for a 128kbps download, and then
produces a file twice the size holding the same sound, is a lie told by a
program - so it is tested rather than trusted to a comment.
"""

from __future__ import annotations

import pytest

from syncmypod_local import config, downloader, quality


class TestNeverInflating:
    """The ceiling is a maximum, not a target."""

    @pytest.mark.parametrize("preset", quality.PRESETS)
    def test_a_poor_source_is_never_encoded_above_itself(self, preset):
        setting = quality.preset(preset)
        assert setting.bitrate_for(96) == 96

    def test_a_good_source_is_capped_at_the_ceiling(self):
        assert quality.preset("compact").bitrate_for(320) == 128
        assert quality.preset("balanced").bitrate_for(320) == 192

    def test_an_unreadable_source_falls_back_to_the_ceiling(self):
        """Better than guessing low and quietly degrading something that was fine."""
        assert quality.preset("balanced").bitrate_for(None) == 192
        assert quality.preset("balanced").bitrate_for(0) == 192


class TestShrinking:
    def test_off_by_default(self):
        """Re-encoding a lossy file is always a loss, so it is never automatic."""
        assert not quality.preset("balanced").shrink_to_ceiling
        assert not quality.preset("high").shrink_to_ceiling

    def test_a_file_at_the_ceiling_is_left_alone(self):
        """The mistake a naive "always convert" setting makes.

        Re-encoding a 128kbps file to a 128kbps ceiling costs quality and saves
        nothing at all.
        """
        assert not quality.preset("compact").needs_shrinking(128)
        assert not quality.preset("compact").needs_shrinking(96)

    def test_a_file_over_the_ceiling_is_shrunk(self):
        assert quality.preset("compact").needs_shrinking(256)

    def test_never_when_the_setting_is_off(self):
        assert not quality.preset("balanced").needs_shrinking(320)


class TestPresets:
    def test_high_chases_the_best_source(self):
        """Accepting a conversion is the trade "high" makes."""
        assert quality.preset("high").prefer_no_reencode is False

    def test_balanced_avoids_a_conversion(self):
        assert quality.preset("balanced").prefer_no_reencode is True

    def test_an_unknown_name_falls_back_rather_than_failing(self):
        assert quality.preset("nonsense").name == "balanced"
        assert quality.preset("").name == "balanced"


class TestNaming:
    def test_changing_a_field_makes_it_custom(self):
        """So the interface never shows "balanced" next to settings that are not."""
        changed = quality.preset("balanced").with_changes(max_bitrate_kbps=256)
        assert changed.name == "custom"

    def test_changing_back_restores_the_preset_name(self):
        changed = quality.preset("balanced").with_changes(max_bitrate_kbps=256)
        assert changed.with_changes(max_bitrate_kbps=192).name == "balanced"

    def test_settings_that_happen_to_match_a_preset_are_named_after_it(self):
        assert quality.preset("high").with_changes(max_bitrate_kbps=128).name == "custom"


class TestFormatSelector:
    """What yt-dlp is actually asked for."""

    def test_balanced_asks_for_the_playable_format_first(self):
        selector = downloader.format_selector(quality.preset("balanced"))
        assert selector.startswith("bestaudio[ext=m4a]")

    def test_high_asks_for_the_best_stream_first(self):
        selector = downloader.format_selector(quality.preset("high"))
        assert selector.startswith("bestaudio/")

    def test_a_floor_is_applied_to_every_alternative(self):
        setting = quality.preset("balanced").with_changes(min_source_kbps=160)
        selector = downloader.format_selector(setting)
        assert all("[abr>=160]" in part for part in selector.split("/"))

    def test_a_floor_removes_the_catch_all_fallback(self):
        """Otherwise the floor is decoration.

        yt-dlp's bare `best` matches anything, so leaving it in the chain would
        quietly accept a stream below the minimum the user asked for.
        """
        setting = quality.preset("balanced").with_changes(min_source_kbps=128)
        assert "best" not in downloader.format_selector(setting).split("/")

    def test_no_floor_keeps_the_fallback(self):
        """A track that syncs at 96kbps beats one that does not sync."""
        assert "best" in downloader.format_selector(quality.preset("balanced")).split("/")


class TestPersistence:
    def test_it_survives_a_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        wanted = quality.preset("compact").with_changes(min_source_kbps=128, codec="mp3")
        config.save(
            config.Config(server_url="https://x", token="smp_t", quality=wanted)
        )
        assert config.load().quality == wanted

    def test_a_config_without_quality_gets_the_default(self, tmp_path, monkeypatch):
        """Every config written before this setting existed."""
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        (tmp_path / "config.json").write_text(
            '{"server_url": "https://x", "token": "smp_t"}', encoding="utf-8"
        )
        assert config.load().quality == quality.preset("balanced")

    @pytest.mark.parametrize(
        "stored",
        [
            {"name": "balanced", "maxBitrateKbps": "not a number"},
            {"name": "balanced", "codec": "flac"},
            {"name": "balanced", "preferNoReencode": "yes"},
            {"name": "unknown preset"},
            "not even a dict",
            None,
        ],
    )
    def test_nonsense_falls_back_rather_than_failing(self, stored):
        """A hand-edited config should cost the defaults, not a sync."""
        result = quality.from_json(stored)
        assert result.codec in quality.CODECS
        assert 32 <= result.max_bitrate_kbps <= 320

    def test_out_of_range_numbers_are_clamped(self):
        assert quality.from_json({"maxBitrateKbps": 9999}).max_bitrate_kbps == 320
        assert quality.from_json({"minSourceKbps": -50}).min_source_kbps == 0
