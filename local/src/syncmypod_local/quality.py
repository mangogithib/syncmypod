"""What "quality" means, and the three honest controls over it.

It is tempting to offer a bitrate menu running up to 320kbps. That would be a
lie. Almost every track here comes from YouTube, which serves roughly 128kbps
AAC, and encoding that to 320 produces a file two and a half times the size
containing exactly the same sound. Any setting that appears to raise quality
above what the source holds is misleading, so there isn't one.

What can genuinely be chosen is three things:

**Which stream to take.** YouTube usually offers the same recording as AAC and
as Opus, sometimes at different bitrates. Taking the AAC means the iPod can play
it untouched; taking a higher-bitrate Opus means a better source but a mandatory
re-encode, because an iPod cannot play Opus at all. Neither is obviously right,
so it is a setting.

**A floor.** Refuse a track whose best available source is below some bitrate,
rather than putting something that sounds bad on the device. The failure is
reported to the server per track, so it is visible and fixable.

**A ceiling.** When a conversion has to happen anyway, how much to spend on it.
Capped by the source's own bitrate, always - see `bitrate_for`.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

CODECS = ("aac", "mp3")
PRESETS = ("high", "balanced", "compact")

# Offered in the interface. Deliberately stops at 256: above that, nothing this
# tool can reach as a source has the detail to justify it.
BITRATE_CHOICES = (96, 128, 160, 192, 256)
SOURCE_FLOOR_CHOICES = (0, 96, 128, 160, 192)


@dataclass(frozen=True, slots=True)
class Quality:
    """How good the audio should be, and what to refuse."""

    # The preset this came from, or "custom" once a field has been changed by
    # hand. Kept so the interface can show what was chosen rather than having to
    # infer it back from four numbers.
    name: str = "balanced"

    # What a conversion produces. AAC is right for every clickwheel iPod; MP3
    # exists because it is the one format that plays on absolutely anything,
    # including Rockbox and the older devices this may eventually support.
    codec: str = "aac"

    # The most to spend on a re-encode. Never exceeded, and never *reached* if
    # the source is worse - see bitrate_for().
    max_bitrate_kbps: int = 192

    # Refuse a source below this. 0 accepts whatever is available, which is the
    # right default: a track that syncs at 96kbps is more useful than one that
    # does not sync at all.
    min_source_kbps: int = 0

    # Take a stream the iPod can already play, even when a better-sounding one
    # exists in a format it cannot. Off means chase the best source and accept
    # the re-encode that follows.
    prefer_no_reencode: bool = True

    # Shrink a source that is already playable but bigger than the ceiling. Off
    # by default because re-encoding a lossy file is always a loss; on, it is
    # how a large library is made to fit.
    shrink_to_ceiling: bool = False

    def bitrate_for(self, source_kbps: int | None) -> int:
        """What to actually encode at, given what the source holds.

        The cap is the point. Encoding a 128kbps source at 256 produces a file
        twice the size with nothing extra in it, and doing that silently while a
        user believes they chose "high quality" is the specific dishonesty this
        module exists to avoid.
        """
        if not source_kbps or source_kbps <= 0:
            return self.max_bitrate_kbps
        return min(self.max_bitrate_kbps, int(source_kbps))

    def needs_shrinking(self, source_kbps: int | None) -> bool:
        """Whether an already-playable file should be re-encoded smaller.

        Only when it is genuinely over the ceiling. Re-encoding a 128kbps file
        to a 128kbps ceiling would be pure loss for no saving, and that is the
        mistake a naive "always convert" setting makes.
        """
        if not self.shrink_to_ceiling or not source_kbps:
            return False
        return int(source_kbps) > self.max_bitrate_kbps

    def describe(self) -> str:
        """One line for `syncmypod status`."""
        parts = [self.name, f"{self.codec.upper()} up to {self.max_bitrate_kbps}kbps"]
        if self.min_source_kbps:
            parts.append(f"refuse below {self.min_source_kbps}kbps")
        if not self.prefer_no_reencode:
            parts.append("best source")
        if self.shrink_to_ceiling:
            parts.append("shrink larger files")
        return ", ".join(parts)

    def as_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "codec": self.codec,
            "maxBitrateKbps": self.max_bitrate_kbps,
            "minSourceKbps": self.min_source_kbps,
            "preferNoReencode": self.prefer_no_reencode,
            "shrinkToCeiling": self.shrink_to_ceiling,
        }

    def with_changes(self, **changes: Any) -> Quality:
        """A copy, renamed "custom" if it no longer matches its preset.

        So the interface never shows "balanced" next to settings that are not
        balanced any more.
        """
        updated = replace(self, **changes)
        for name in PRESETS:
            if replace(preset(name), name=updated.name) == updated:
                return replace(updated, name=name)
        return replace(updated, name="custom")


def preset(name: str) -> Quality:
    """One of the three named starting points.

    They differ in what they chase rather than in what they promise. "High" goes
    after the best source even when that forces a conversion; "balanced" takes
    whatever the iPod can play as-is; "compact" does that too and additionally
    shrinks anything oversized.
    """
    chosen = (name or "").strip().lower()
    if chosen == "high":
        return Quality(
            name="high",
            codec="aac",
            max_bitrate_kbps=256,
            min_source_kbps=0,
            prefer_no_reencode=False,
            shrink_to_ceiling=False,
        )
    if chosen == "compact":
        return Quality(
            name="compact",
            codec="aac",
            max_bitrate_kbps=128,
            min_source_kbps=0,
            prefer_no_reencode=True,
            shrink_to_ceiling=True,
        )
    return Quality(
        name="balanced",
        codec="aac",
        max_bitrate_kbps=192,
        min_source_kbps=0,
        prefer_no_reencode=True,
        shrink_to_ceiling=False,
    )


def from_json(raw: Any) -> Quality:
    """Read stored settings, falling back rather than failing.

    A config file written by a newer version, or edited by hand into something
    unusable, should cost the default settings and not a sync.
    """
    if not isinstance(raw, dict):
        return preset("balanced")

    base = preset(str(raw.get("name") or "balanced"))
    codec = str(raw.get("codec") or base.codec).lower()

    return base.with_changes(
        codec=codec if codec in CODECS else base.codec,
        max_bitrate_kbps=_bounded(raw.get("maxBitrateKbps"), base.max_bitrate_kbps, 32, 320),
        min_source_kbps=_bounded(raw.get("minSourceKbps"), base.min_source_kbps, 0, 320),
        prefer_no_reencode=_flag(raw.get("preferNoReencode"), base.prefer_no_reencode),
        shrink_to_ceiling=_flag(raw.get("shrinkToCeiling"), base.shrink_to_ceiling),
    )


def _bounded(value: Any, fallback: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _flag(value: Any, fallback: bool) -> bool:
    return bool(value) if isinstance(value, bool) else fallback
