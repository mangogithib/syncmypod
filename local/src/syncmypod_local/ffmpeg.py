"""Finding ffmpeg, wherever it happens to be.

Two different consumers need it and they ask for it differently: yt-dlp wants a
directory (``ffmpeg_location``), pypodlib's transcoder wants the path to the
binary. Both come from here so there is one answer rather than two.

The shipped application carries its own copy. Relying on the user having ffmpeg
installed is the single most common way a tool like this fails on someone else's
machine, and "install ffmpeg and add it to PATH" is not an instruction most
people should have to follow. A bundled binary is found first, before anything
on PATH, so the version the app was tested against is the version it uses.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# Where a bundled copy is looked for, relative to each root that gets searched.
# Kept as a list so the packaging layout can change without touching callers.
_BUNDLE_SUBDIRS = ("", "ffmpeg", "bin", "_bin")

_EXE = ".exe" if os.name == "nt" else ""


class FfmpegMissing(Exception):
    """No usable ffmpeg, phrased for someone who did not expect to care."""


@dataclass(frozen=True, slots=True)
class Ffmpeg:
    """A located pair of binaries.

    Both are needed. The transcoder probes with ffprobe before it encodes, and a
    build with one but not the other fails halfway through a sync rather than at
    the start, which is the worse time to find out.
    """

    ffmpeg: Path
    ffprobe: Path

    @property
    def directory(self) -> Path:
        """What yt-dlp's ``ffmpeg_location`` expects."""
        return self.ffmpeg.parent

    @property
    def bundled(self) -> bool:
        """Whether this came with the application rather than from the system."""
        return any(_is_within(self.ffmpeg, root) for root in _bundle_roots())


@lru_cache(maxsize=1)
def find() -> Ffmpeg | None:
    """Locate ffmpeg and ffprobe, or None if either is missing.

    Order is deliberate: an explicit override, then the copy shipped with the
    application, then PATH. The bundled copy outranks the system one because a
    user's own ffmpeg may be years old or built without the encoders needed, and
    a sync that silently produces a file the iPod refuses to play is worse than
    one that uses a known-good binary.
    """
    override = os.environ.get("SYNCMYPOD_FFMPEG")
    if override:
        found = _pair_in(Path(override)) or _pair_from_binary(Path(override))
        if found:
            return found

    for root in _bundle_roots():
        for sub in _BUNDLE_SUBDIRS:
            found = _pair_in(root / sub if sub else root)
            if found:
                return found

    on_path = shutil.which("ffmpeg")
    probe_on_path = shutil.which("ffprobe")
    if on_path and probe_on_path:
        return Ffmpeg(Path(on_path), Path(probe_on_path))
    return None


def require() -> Ffmpeg:
    """Locate ffmpeg, or raise a message that says what to do about it."""
    found = find()
    if found is None:
        raise FfmpegMissing(
            "ffmpeg could not be found, and it is needed to fetch and convert "
            "audio. This application normally ships with its own copy - if you "
            "are running from source, install ffmpeg and put it on your PATH, "
            "or point SYNCMYPOD_FFMPEG at it."
        )
    return found


def describe() -> str:
    """One line for `syncmypod status`."""
    found = find()
    if found is None:
        return "not found"
    return f"{found.ffmpeg} ({'bundled' if found.bundled else 'system'})"


def _bundle_roots() -> list[Path]:
    """Every directory a bundled copy could plausibly sit in.

    Covers both PyInstaller layouts - onefile unpacks to ``sys._MEIPASS``, onedir
    puts data beside the executable - and a source checkout that has had a binary
    dropped into the package, which is how the bundled path gets tested without
    building an installer first.
    """
    roots: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass))
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).parent)
    roots.append(Path(__file__).resolve().parent)
    return roots


def _pair_in(directory: Path) -> Ffmpeg | None:
    """Both binaries in one directory, or nothing."""
    try:
        if not directory.is_dir():
            return None
    except OSError:
        return None
    ffmpeg = directory / f"ffmpeg{_EXE}"
    ffprobe = directory / f"ffprobe{_EXE}"
    if ffmpeg.is_file() and ffprobe.is_file():
        return Ffmpeg(ffmpeg, ffprobe)
    return None


def _pair_from_binary(binary: Path) -> Ffmpeg | None:
    """SYNCMYPOD_FFMPEG pointing at the executable rather than its directory."""
    if binary.is_file():
        return _pair_in(binary.parent)
    return None


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False
