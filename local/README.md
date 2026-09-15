# SyncMyPod — local sync app

The component of [SyncMyPod](../README.md) that runs
on the computer your iPod is plugged into.

The web tool in [`web/`](../web/) holds your library and **never touches audio**.
This does: it reads
what should be on the iPod, downloads whatever is missing, re-tags it from the
server's resolved metadata, writes it to the device, and deletes every
downloaded file once the transfer is confirmed.

Two halves of one project. The server runs continuously and holds only
data; this runs occasionally, holds nothing permanently, and is the only part
that needs to be near the hardware.

---

## Status

Working, and verified against real hardware — an iPod Classic 6.5th gen already
holding 184 tracks from another tool. Both the CLI and a first GUI are here.

Not built yet: packaging into a single executable. Until then this runs from a
source checkout.

---

## Install

**Download the latest release**, unpack the zip anywhere, and double-click
`SyncMyPod.exe`. It opens the application in a window of its own, with no
console behind it. ffmpeg is included, so there is nothing else to install.

`syncmypod.exe` sits beside it for the command line - `syncmypod.exe sync
--dry-run`, `syncmypod.exe check-matches` - which is the same engine with a
terminal in front of it instead of a window.

Windows Defender may quarantine it on first run. That is a false positive every
unsigned build attracts, not a sign of anything wrong with the download — code
signing is the real fix and it costs money.

### From source

Requires Python 3.11 or newer.

```bash
pip install -e .
python scripts/fetch_ffmpeg.py
```

The second command downloads the ffmpeg build that ships inside the application.
It is needed rather than optional: without it nothing can be fetched and nothing
can be converted. If you would rather use your own, skip it — anything on your
PATH is used as a fallback, and `SYNCMYPOD_FFMPEG` overrides both.

## Use

On Windows, `syncmypod.cmd` in this directory finds the virtualenv for you.
Double-click it to open the window, or pass it any command:

```
syncmypod.cmd
syncmypod.cmd sync --dry-run
```

Everything below works the same way through `syncmypod` itself once the package
is installed.

Nothing here needs a terminal: `SyncMyPod.exe` opens a window that pairs, signs
in to YouTube, and syncs. The commands below are the same actions for a script
or a scheduled task, through `syncmypod.exe`.

```bash
# Link this computer to your library. Generate the code in the web
# interface under Devices. Your password is never needed or stored here.
syncmypod pair https://your-server:8444 ABCD1234

# What is paired, whether the server answers, and what is plugged in
syncmypod status

# See what a sync would do. Writes nothing.
syncmypod sync --dry-run

# Do it
syncmypod sync

# The window, if you would rather not use a terminal
syncmypod gui

# Sign in to YouTube for 256kbps instead of 128
syncmypod youtube sign-in firefox

# Flush and unmount before you pull the cable
syncmypod eject
```

## Audio quality

Signed out, YouTube offers one AAC stream at about 128kbps. A **YouTube Music
Premium** account is offered the same recording at **256kbps** — which matters,
because the iTunes Store sold music at 256 and an iPod Classic plays up to 320.

```bash
syncmypod youtube             # what YouTube is currently offering
syncmypod youtube sign-in     # borrow the session from Firefox
syncmypod youtube sign-out    # delete it again
```

There is no password to type. The session is borrowed from a browser already
signed in to YouTube, and **only youtube.com cookies are kept** — nothing from
any other site, and nothing from your Google account, because yt-dlp's YouTube
extractor never asks for anything else.

Two practical notes. Use **Firefox** on Windows: Chromium locks its cookie
database while running, and since Chrome 127 seals it so another program cannot
read it at all. And the saved file is a login session, so it is written 0600
where the platform supports it and `sign-out` deletes it.

There is deliberately no bitrate setting. The right answer is always "the best
AAC this account is offered", which needs no choosing.

`sync --eject` does the last one for you when the run finishes. Worth using: a
freshly written database can still be sitting in the operating system's write
cache, and unplugging then is how an iPod ends up with a library it cannot
read.

Useful flags on `sync`:

| | |
|---|---|
| `--dry-run` | Work out the plan and stop |
| `--limit N` | Download at most N tracks, to keep a first run short |
| `--remove` | Also delete tracks this tool added that have left the library |
| `--mount D:\` | Point at a device instead of scanning for one |
| `--eject` | Unmount the iPod when the run finishes |
| `--verbose` | Log what each step is doing |

Exit codes are meaningful, so this can be driven from a scheduled task: `0`
success, `1` a problem you can fix, `2` bad usage, `130` interrupted.

## The window

`syncmypod gui` serves a page to your browser and opens it: what is plugged in,
what is missing, a button, and live progress.

It is not a web application. It listens on this computer only, on a port the
system picks, and needs a token generated at startup — the link printed in the
terminal carries it. It stops when the command does. Pairing stays in the CLI,
since it is a once-per-computer job.

---

## Where things are kept

The pairing lives in one small file, in the location your platform expects:

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\SyncMyPod\config.json` |
| macOS | `~/Library/Application Support/SyncMyPod/config.json` |
| Linux | `~/.config/SyncMyPod/config.json` |

It holds the server address and a bearer token, and is written `600` on
POSIX. Set `SYNCMYPOD_CONFIG_DIR` to put it elsewhere.

Two other things live beside it. **Backups** go in a `backups` folder next to
the config — full snapshots of the iPod, taken before every run, so the folder
grows to roughly the size of the music on the device. They are content-addressed,
so a second snapshot of an unchanged iPod costs almost nothing. Set
`SYNCMYPOD_BACKUP_DIR` to move them.

And the **record of what was synced** is kept on the iPod itself, at
`iPod_Control/Device/SyncMyPod.json`. It lives there rather than here so that
syncing the same device from a second computer continues one history instead of
starting another. Deleting it is safe; the next run falls back to matching on
title, artist and album.

**Your account password is never stored on this machine.** Pairing trades a
short-lived code for a long-lived token, and the token can be revoked from the
web interface without changing your password — which is the point: a lost laptop
is a revoked token, not a password reset.

---

## Building the download

```bash
python scripts/build.py
```

Fetches ffmpeg, runs PyInstaller, and writes
`dist/SyncMyPod-<version>-windows-x64.zip` — about 174MB, 395MB unpacked, most
of it ffmpeg. CI does the same on a `local-v*` tag and attaches the result to a
GitHub release.

A zipped folder rather than one executable, deliberately. PyInstaller's one-file
mode unpacks the whole bundle to a temporary directory on every launch, which
with 148MB of ffmpeg would be a ten-second wait each time. The download is still
a single file; what comes out of it is a folder.

## How a sync runs

1. Confirm the token and the manifest version
2. Detect the iPod and tell the server what it is
3. Fetch the manifest — every track and playlist that should be on the device
4. Diff against what is already there
5. Download what is missing, **re-tag it from the manifest**, transcode if the
   iPod cannot play the format
6. Write tracks and playlists to the iPod database, signing it if the device
   requires that
7. Build the device's artwork database, so covers show on its screen
8. Ask before removing anything no longer in the library
9. **Delete every downloaded file**

Step 5 is the rule the whole architecture exists for: whatever metadata a
download source embedded is discarded and replaced with the server's resolved
version. Raw source metadata routinely collapses several artists into one field
or amounts to little more than a video title.

The contract is specified in the server repository's
[docs/LOCAL_APP_API.md](../docs/LOCAL_APP_API.md).

---

## Device support

Targeting clickwheel iPods. The difference that matters is whether the database
needs a cryptographic signature:

| Device | Signature |
|---|---|
| iPod 5th gen (Video), Nano 1–3 | None |
| iPod Classic 6th/7th gen, Nano 4+ | `hash58` |
| Later iOS-era devices | `hash72`, `hashAB` |

Get this wrong and the iPod boots to an **empty library with every file still on
disk** — the most confusing possible failure. So the device layer reads the
scheme from the device rather than inferring it, and treats anything it cannot
identify as requiring a signature, because that error is the harmless one.

### Testing without hardware

pyPodLib can simulate any of 204 iPod models, including the exact ones this
targets. The test suite runs against simulated devices, so the sync path —
including writing and signing a database — is exercised without risking real
hardware:

```bash
pytest                 # runs against simulated iPods
pytest -m hardware     # opts in to tests needing a real device
```

---

## Design notes

**pyPodLib is quarantined in one file.** `device.py` is the only module that
imports it. pyPodLib is the right choice — MIT, extracted from iOpenPod, and the
only open-source implementation covering the modern signatures — but it is at
`0.1.0`, alpha, with a single release, and it is what rewrites the database your
iPod boots from. It is pinned to an exact version, and every other module talks
to this project's own `IpodDevice` type. Replacing or forking it changes one
file.

**Every run takes a backup first.** `IPod.backup()` gives a restore point before
anything is written. Writing a database is the one operation that can leave a
device unusable; a snapshot costs a moment.

**Errors are written to be read.** Anything the user can act on is raised with a
message saying what to do, and printed without a traceback. Tracebacks are for
bugs, not for "no iPod plugged in".

---

## Licence

MIT. Uses [pyPodLib](https://github.com/La22e/pyPodLib) (MIT), extracted from
[iOpenPod](https://github.com/TheRealSavi/iOpenPod) (MIT), whose iTunesDB engine
makes this possible at all.
