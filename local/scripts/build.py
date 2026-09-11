"""Build the downloadable application.

    python scripts/build.py

Fetches ffmpeg if it is not already there, runs PyInstaller, and zips the result
into ``dist/SyncMyPod-<version>-<platform>.zip`` - which is the single file a
release publishes and a user downloads.

**Why a zipped folder rather than one executable.** PyInstaller can produce a
single file, and it does it by unpacking the whole bundle into a temporary
directory every time the program starts. This bundle carries 148MB of ffmpeg, so
that would be a ten-second wait on every run to save the user seeing a folder.
The zip means the download is still one file; what comes out of it is a folder
with `syncmypod.exe` in it.

**Why the build directory is outside the project.** PyInstaller writes tens of
thousands of files while it works. The project lives in a synced folder on the
machine this was developed on, and pointing the build at it meant the sync
client trying to upload every intermediate. It also keeps Windows' 260-character
path limit at arm's length, which PyInstaller hits surprisingly easily with
nested package data.
"""

from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "syncmypod.spec"
BUNDLED_FFMPEG = ROOT / "src" / "syncmypod_local" / "_bin"


def version() -> str:
    text = (ROOT / "src" / "syncmypod_local" / "__init__.py").read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.startswith("__version__"):
            return line.split("=")[1].strip().strip('"').strip("'")
    return "0.0.0"


def platform_tag() -> str:
    system = {"windows": "windows", "darwin": "macos", "linux": "linux"}.get(
        platform.system().lower(), platform.system().lower()
    )
    machine = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    return f"{system}-{machine}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work",
        default=None,
        help="Where PyInstaller builds (default: a short temporary path)",
    )
    parser.add_argument(
        "--skip-ffmpeg",
        action="store_true",
        help="Assume ffmpeg is already in src/syncmypod_local/_bin",
    )
    args = parser.parse_args()

    if not args.skip_ffmpeg:
        print("== ffmpeg ==")
        fetch = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "fetch_ffmpeg.py")],
            cwd=ROOT,
            check=False,
        )
        if fetch.returncode != 0:
            print("Could not fetch ffmpeg.", file=sys.stderr)
            return 1

    if not any(BUNDLED_FFMPEG.glob("ffmpeg*")):
        print(
            f"No ffmpeg in {BUNDLED_FFMPEG}. The build would produce an application "
            "that cannot download or convert anything.",
            file=sys.stderr,
        )
        return 1

    # A short path, well clear of the 260-character limit, and outside any
    # directory a sync client might be watching.
    work = Path(args.work) if args.work else Path(tempfile.gettempdir()) / "syncmypod-build"
    work.mkdir(parents=True, exist_ok=True)
    staged = work / "dist"

    print("\n== PyInstaller ==")
    build = subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(staged),
            "--workpath",
            str(work / "work"),
            str(SPEC),
        ],
        cwd=SPEC.parent,
        check=False,
    )
    if build.returncode != 0:
        return build.returncode

    bundle = staged / "syncmypod"
    if not bundle.is_dir():
        print(f"PyInstaller produced nothing at {bundle}.", file=sys.stderr)
        return 1

    print("\n== packaging ==")
    output = ROOT / "dist"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"SyncMyPod-{version()}-{platform_tag()}.zip"
    archive.unlink(missing_ok=True)

    # Deflate rather than the default store, and written with a top-level folder
    # so unzipping never scatters 400MB of files into whatever directory the
    # user happened to be in.
    total = 0
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
        for path in sorted(bundle.rglob("*")):
            if path.is_file():
                zipped.write(path, Path("SyncMyPod") / path.relative_to(bundle))
                total += path.stat().st_size

    print(f"\n  unpacked  {total / 1024 / 1024:>8.0f} MB")
    print(f"  zipped    {archive.stat().st_size / 1024 / 1024:>8.0f} MB")
    print(f"\n{archive}")

    if os.name == "nt":
        print(
            "\nWindows Defender may quarantine this on first run. That is a false "
            "positive every unsigned PyInstaller build attracts; code signing is "
            "the only real fix and it costs money."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
