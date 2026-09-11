"""Getting a downloaded file into a format the attached iPod will play.

The second of the two modules that import pypodlib - see ``device.py`` for why
that is kept deliberately small. This one wraps pypodlib's transcoder, and the
reason for using it rather than calling ffmpeg directly is worth stating,
because the naive version looks so much simpler.

"An iPod cannot play Opus, so convert Opus to AAC" is about a third of the real
rule. A clickwheel iPod also refuses AAC that is not Low Complexity, so the
HE-AAC a source may hand back plays as silence; it refuses sample rates above
48kHz and 24-bit depth, so a hi-res download is rejected; and the format limits
differ by model. pypodlib already encodes all of that, keyed to the device
currently open, and it is knowledge this project has no reason to duplicate and
every reason to get wrong.

The common case does no work at all: the downloader asks for the AAC stream
first, so the file usually arrives already playable and is passed through
untouched. Re-encoding a lossy source into another lossy format is pure loss,
and the fastest transcode is the one that does not happen.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from . import ffmpeg as ffmpeg_finder
from .quality import Quality, preset

logger = logging.getLogger(__name__)


class TranscodeError(Exception):
    """The file could not be made playable, phrased for a user."""


@dataclass(slots=True)
class Converted:
    """The file to write to the iPod, and whether it had to be re-encoded."""

    path: Path
    was_transcoded: bool
    target: str
    bitrate_kbps: int | None = None

    @property
    def format(self) -> str:
        """The extension the server records as ``format``, without the dot."""
        return self.path.suffix.lstrip(".").lower()


def prepare(source: Path, destination: Path, quality: Quality | None = None) -> Converted:
    """Return a version of *source* the open device can play.

    Call this only after the iPod has been opened: pypodlib decides the target
    from whichever device is current, so the answer for a 5th gen Video and a
    Classic are allowed to differ.
    """
    from pypodlib.sync.transcoder import (
        TranscodeOptions,
        TranscodeTarget,
        probe_audio,
        resolve_transcode_plan,
        transcode,
    )

    wanted = quality or preset("balanced")
    source_kbps = _source_bitrate(probe_audio, source)
    target_kbps = wanted.bitrate_for(source_kbps)

    options = TranscodeOptions(
        ffmpeg_path=_ffmpeg_path(),
        # "auto" resolves to the best available AAC encoder, which is what every
        # clickwheel iPod wants. MP3 is offered because it is the one format
        # that plays on absolutely anything.
        lossy_encoder="libmp3lame" if wanted.codec == "mp3" else "auto",
        bitrate_mode="cbr",
        music_lossy_cbr_bitrate=target_kbps,
        # Only ever set when the source is genuinely larger than the ceiling.
        # Turning this on unconditionally would re-encode a 128kbps file to a
        # 128kbps ceiling: a loss of quality in exchange for nothing.
        always_encode_lossy=wanted.needs_shrinking(source_kbps),
    )

    try:
        plan = resolve_transcode_plan(source, options=options)
    except Exception as err:
        raise TranscodeError(f"Could not inspect {source.name}: {err}") from err

    if plan.target == TranscodeTarget.COPY:
        # Already playable and within the ceiling. Tag it and hand it over where
        # it is - copying it somewhere else first would only mean deleting two
        # files instead of one.
        logger.info("%s needs no conversion (%s kbps)", source.name, source_kbps or "?")
        return Converted(
            path=source, was_transcoded=False, target="copy", bitrate_kbps=source_kbps
        )

    # Anything else means ffmpeg, so find out now rather than after the encode
    # has been set up.
    ffmpeg_finder.require()
    logger.info(
        "Converting %s to %s at %dkbps (source %s kbps)",
        source.name, plan.target.value, target_kbps, source_kbps or "?",
    )

    destination.mkdir(parents=True, exist_ok=True)
    try:
        result = transcode(
            source, destination, output_filename="converted", plan=plan, options=options
        )
    except Exception as err:
        raise TranscodeError(f"Converting {source.name} failed: {err}") from err

    if not result.success or result.output_path is None:
        raise TranscodeError(
            f"Converting {source.name} failed: {result.error_message or 'no output produced'}"
        )

    return Converted(
        path=Path(result.output_path),
        was_transcoded=bool(result.was_transcoded),
        target=plan.target.value,
        bitrate_kbps=target_kbps,
    )


def available() -> bool:
    """Whether a conversion could run if one turned out to be needed."""
    return ffmpeg_finder.find() is not None


def _source_bitrate(probe, source: Path) -> int | None:
    """What the source actually holds, or None if it cannot be read.

    None matters: it means the ceiling cannot be capped to the source, so the
    requested bitrate is used as-is. Better than guessing a low number and
    quietly degrading something that was fine.
    """
    try:
        properties = probe(source)
    except Exception as err:
        logger.debug("Could not probe %s: %s", source.name, err)
        return None
    value = getattr(properties, "bitrate_kbps", None)
    return int(value) if value else None


def _ffmpeg_path() -> str:
    """The bundled binary if there is one, otherwise let pypodlib search PATH."""
    found = ffmpeg_finder.find()
    return str(found.ffmpeg) if found else ""
