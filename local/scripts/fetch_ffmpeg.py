"""Fetch the ffmpeg binaries that ship inside the application.

Run once before packaging, or once in a source checkout to test the bundled
path. Everything lands in ``src/syncmypod_local/_bin``, which is gitignored and
is the first place ``ffmpeg.find()`` looks.

    python scripts/fetch_ffmpeg.py

Three decisions are worth explaining.

**Why bundle at all.** "Install ffmpeg and add it to your PATH" is not an
instruction most people should have to follow, and without ffmpeg this
application can neither fetch audio nor convert it - so a missing ffmpeg is not
a degraded experience, it is a tool that does nothing. Shipping a known-good
copy also means the version tested is the version that runs, rather than
whatever a user installed years ago and which may lack the AAC encoder.

**Why LGPL builds specifically.** ffmpeg is distributed in two flavours. The
"full" or GPL builds include GPL-licensed components; the LGPL builds do not.
This project is MIT, and while ffmpeg is invoked as a separate process rather
than linked - which is the usual argument for shipping a GPL build alongside a
differently-licensed application - that argument is contested, and there is no
reason to rely on it when an LGPL build does everything needed here. The LGPL
still requires that the source be offered; SOURCE_NOTICE below is written
alongside the binaries so the obligation travels with them.

**Why shared libraries on Windows and static everywhere else.** The static
Windows build is 255MB, because ffmpeg.exe and ffprobe.exe each embed a complete
copy of every codec library. The shared build is 148MB for the same
capabilities - the two executables shrink to under a megabyte between them and
share one set of DLLs. Windows loads DLLs sitting next to the executable without
being told to, so this costs nothing but a few more files. Elsewhere a shared
build would need LD_LIBRARY_PATH or an rpath fixup to find its libraries, which
is real complexity for a platform whose users mostly have ffmpeg already.
"""

from __future__ import annotations

import argparse
import io
import platform
import shutil
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

DESTINATION = Path(__file__).resolve().parent.parent / "src" / "syncmypod_local" / "_bin"

# BtbN's builds are the ones that publish an explicit LGPL variant per platform,
# which is why they are used rather than the more commonly linked gyan.dev or
# evermeet builds - both of which are GPL.
RELEASES = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"

BUILDS = {
    "windows-x86_64": f"{RELEASES}/ffmpeg-master-latest-win64-lgpl-shared.zip",
    "linux-x86_64": f"{RELEASES}/ffmpeg-master-latest-linux64-lgpl.tar.xz",
    "linux-aarch64": f"{RELEASES}/ffmpeg-master-latest-linuxarm64-lgpl.tar.xz",
}

# The media player. Nothing here plays audio, and it is 18MB.
UNWANTED = {"ffplay.exe", "ffplay"}

SOURCE_NOTICE = """\
ffmpeg and ffprobe in this directory, and the libraries beside them, are
unmodified binaries from https://github.com/BtbN/FFmpeg-Builds, built from
https://github.com/FFmpeg/FFmpeg and licensed under the LGPL v2.1 or later.

They are invoked as separate processes and are not linked into this application.
The corresponding source is available from the FFmpeg project at the address
above; the build configuration is recorded in the output of `ffmpeg -version`.
"""


def target() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(
        machine, machine
    )
    return f"{system}-{machine}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--platform", default=target(), help="Which build to fetch (default: this machine's)"
    )
    parser.add_argument(
        "--force", action="store_true", help="Re-download even if binaries are already there"
    )
    args = parser.parse_args()

    if args.platform not in BUILDS:
        # macOS is the gap. Every readily available static macOS build is GPL,
        # so bundling one is a licensing decision rather than a download, and it
        # is left to be made deliberately rather than made here by accident.
        print(f"No LGPL build is configured for {args.platform}.", file=sys.stderr)
        print(f"Configured: {', '.join(sorted(BUILDS))}", file=sys.stderr)
        return 1

    exe = ".exe" if args.platform.startswith("windows") else ""
    required = [f"ffmpeg{exe}", f"ffprobe{exe}"]

    if not args.force and all((DESTINATION / name).is_file() for name in required):
        print(f"Already present in {DESTINATION}. Use --force to replace them.")
        return 0

    url = BUILDS[args.platform]
    print(f"Downloading {url}")
    with urllib.request.urlopen(url, timeout=600) as response:
        payload = response.read()
    print(f"  {len(payload) / 1024 / 1024:.0f} MB compressed")

    # Replaced wholesale rather than merged: a leftover DLL from an older build
    # sitting beside a new executable is the kind of mismatch that fails at the
    # first conversion rather than at extraction time.
    #
    # The contents go, not the directory. Removing the directory itself fails on
    # Windows whenever anything holds a handle to it - a sync client, the search
    # indexer, an open Explorer window - and it emptied the folder before
    # failing, which left the application with no ffmpeg at all.
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for existing in DESTINATION.iterdir():
        if existing.is_dir():
            shutil.rmtree(existing, ignore_errors=True)
        else:
            existing.unlink(missing_ok=True)

    extracted = _extract(payload, url)
    missing = set(required) - set(extracted)
    if missing:
        print(f"The archive did not contain {', '.join(sorted(missing))}.", file=sys.stderr)
        return 1

    (DESTINATION / "SOURCE_NOTICE.txt").write_text(SOURCE_NOTICE, encoding="utf-8")

    total = sum(path.stat().st_size for path in DESTINATION.iterdir() if path.is_file())
    print(f"\nInstalled {len(extracted)} file(s) into {DESTINATION}:")
    for name in sorted(extracted):
        print(f"  {name:<24} {(DESTINATION / name).stat().st_size / 1024 / 1024:>7.1f} MB")
    print(f"  {'total':<24} {total / 1024 / 1024:>7.1f} MB")
    print("\nCheck it is picked up with:  syncmypod status")
    return 0


def _extract(payload: bytes, url: str) -> list[str]:
    """Pull the executables and their libraries out, flattening directories.

    These archives nest everything under a versioned directory and split
    executables from libraries, which would put both somewhere the finder does
    not look. Everything useful ends up in one flat directory, which is also
    exactly how Windows expects to find a DLL: next to the executable that
    needs it.
    """
    keep_suffixes = (".exe", ".dll", ".so") if url.endswith(".zip") else ("",)
    found: list[str] = []

    def wanted(name: str) -> bool:
        if not name or name in UNWANTED:
            return False
        if url.endswith(".zip"):
            return name.lower().endswith((".exe", ".dll"))
        # The static tarballs carry the two binaries and nothing else worth
        # having, so they are named rather than pattern-matched.
        return name in {"ffmpeg", "ffprobe"}

    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for member in archive.namelist():
                name = Path(member).name
                if wanted(name):
                    with archive.open(member) as source, (DESTINATION / name).open("wb") as out:
                        shutil.copyfileobj(source, out)
                    found.append(name)
    else:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:xz") as archive:
            for member in archive.getmembers():
                name = Path(member.name).name
                if member.isfile() and wanted(name):
                    source = archive.extractfile(member)
                    if source is None:
                        continue
                    with source, (DESTINATION / name).open("wb") as out:
                        shutil.copyfileobj(source, out)
                    found.append(name)

    # The executable bit does not survive extraction on POSIX.
    for name in found:
        if name.endswith(keep_suffixes) or "." not in name:
            path = DESTINATION / name
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return found


if __name__ == "__main__":
    sys.exit(main())
