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

Early. What works today:

- **Pairing** — exchange a code from the web interface for a device token
- **Device detection** — identify a connected iPod, its model, generation, and
  which database signature it requires
- **Server connection** — authenticate, and refuse to run against a manifest
  version this build does not understand

Not built yet: the sync engine itself (download, tag, transcode, write, clean
up) and the GUI. The CLI comes first so the engine is testable; the GUI is a
layer on top of it.

---

## Install

Requires Python 3.11 or newer. A single-file executable will be published once
the sync engine lands; until then:

```bash
pip install -e .
```

`ffmpeg` must be on your PATH for transcoding — an iPod cannot play the Opus
audio most sources hand back.

## Use

```bash
# Link this computer to your library. Generate the code in the web
# interface under Devices. Your password is never needed or stored here.
syncmypod pair https://your-server:8444 ABCD1234

# What is paired, whether the server answers, and what is plugged in
syncmypod status

# Just the attached devices
syncmypod devices

# Forget the local pairing (does not revoke it on the server)
syncmypod unpair
```

Exit codes are meaningful, so this can be driven from a scheduled task: `0`
success, `1` a problem you can fix, `2` bad usage, `130` interrupted.

---

## Where things are kept

The pairing lives in one small file, in the location your platform expects:

| | |
|---|---|
| Windows | `%APPDATA%\SyncMyPod\config.json` |
| macOS | `~/Library/Application Support/SyncMyPod/config.json` |
| Linux | `~/.config/SyncMyPod/config.json` |

It holds the server address and a bearer token, and is written `600` on
POSIX. Set `SYNCMYPOD_CONFIG_DIR` to put it elsewhere.

**Your account password is never stored on this machine.** Pairing trades a
short-lived code for a long-lived token, and the token can be revoked from the
web interface without changing your password — which is the point: a lost laptop
is a revoked token, not a password reset.

---

## How it will sync

Once the engine lands, a run is:

1. Confirm the token and the manifest version
2. Detect the iPod and tell the server what it is
3. Fetch the manifest — every track and playlist that should be on the device
4. Diff against what is already there
5. Download what is missing, **re-tag it from the manifest**, transcode if the
   iPod cannot play the format
6. Write tracks and playlists to the iPod database, signing it if the device
   requires that
7. Ask before removing anything no longer in the library
8. **Delete every downloaded file**

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
