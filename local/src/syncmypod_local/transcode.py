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

**The common case is now a convert, and that is deliberate.** Until
15 September the downloader asked for YouTube's AAC stream so that nothing here
had to run. Measuring the streams changed that - see `downloader.py` - and the
file that arrives is usually Opus, which an iPod cannot play at all.

So the setting below matters more than it used to. ``lossy_quality="high"``
asks pypodlib for **256kbps** rather than its default 192. On the Opus that
YouTube serves, measured against the source it was made from:

    192kbps (the default)   rolls off from 19.5kHz   error -28.7dB
    256kbps ("high")        full 20.1kHz             error -32.1dB

256 is where the second encode stops being what limits the result: it
reproduces the source's spectrum to within 0.2dB in every band, and going on to
320 buys another 4dB of accuracy for a quarter more space on the device. The
output is AAC-LC at 48kHz, which is inside every limit a clickwheel iPod has.

A file that arrives already playable is still passed through untouched - a
Premium account's 256kbps AAC needs nothing done to it, and re-encoding it
would be pure loss.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from . import ffmpeg as ffmpeg_finder

logger = logging.getLogger(__name__)


class TranscodeError(Exception):
    """The file could not be made playable, phrased for a user."""


@dataclass(slots=True)
class Converted:
    """The file to write to the iPod, and whether it had to be re-encoded."""

    path: Path
    was_transcoded: bool
    target: str

    @property
    def format(self) -> str:
        """The extension the server records as ``format``, without the dot."""
        return self.path.suffix.lstrip(".").lower()


def prepare(source: Path, destination: Path) -> Converted:
    """Return a version of *source* the open device can play.

    Call this only after the iPod has been opened: pypodlib decides the target
    from whichever device is current, so the answer for a 5th gen Video and a
    Classic are allowed to differ.
    """
    from pypodlib.sync.transcoder import (
        TranscodeOptions,
        TranscodeTarget,
        resolve_transcode_plan,
        transcode,
    )

    # "high" is 256kbps where the default is 192. The docstring has the
    # measurements; the short version is that this is the difference between
    # keeping the source's top octave and rolling it off.
    options = TranscodeOptions(ffmpeg_path=_ffmpeg_path(), lossy_quality="high")

    try:
        plan = resolve_transcode_plan(source, options=options)
    except Exception as err:
        raise TranscodeError(f"Could not inspect {source.name}: {err}") from err

    if plan.target == TranscodeTarget.COPY:
        # Already playable. Tag it and hand it over where it is - copying it
        # somewhere else first would only mean deleting two files instead of one.
        logger.info("%s needs no conversion", source.name)
        return Converted(path=source, was_transcoded=False, target="copy")

    # Anything else means ffmpeg, so find out now rather than after the encode
    # has been set up.
    ffmpeg_finder.require()
    logger.info("Converting %s to %s", source.name, plan.target.value)

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
    )


def available() -> bool:
    """Whether a conversion could run if one turned out to be needed."""
    return ffmpeg_finder.find() is not None


def _ffmpeg_path() -> str:
    """The bundled binary if there is one, otherwise let pypodlib search PATH."""
    found = ffmpeg_finder.find()
    return str(found.ffmpeg) if found else ""
