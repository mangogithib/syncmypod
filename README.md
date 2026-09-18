# SyncMyPod

A self-hosted music library manager for classic and clickwheel iPods.

Curate your library from any browser — including your phone. A small app on the
computer the iPod is plugged into does the downloading, tagging and syncing.

```
   phone / browser              your server                 computer + iPod
  ┌────────────────┐         ┌────────────────┐          ┌────────────────┐
  │  add songs     │  HTTPS  │  library data  │  HTTPS   │  download      │
  │  make playlists├────────►│  playlists     │◄─────────┤  tag, convert  │
  │  fix metadata  │         │  no audio ever │  manifest│  write to iPod │
  └────────────────┘         └────────────────┘          └───────┬────────┘
                                                                 │ USB
                                                             ┌───▼───┐
                                                             │ iPod  │
                                                             └───────┘
```

---

## Is this for you?

**Yes, if** you have a clickwheel iPod you still use, you are willing to run a
small server (a Raspberry Pi, a VPS, or any machine with Docker), and you want
to manage what is on it from your phone rather than from iTunes.

**Probably not, if** you want a one-click desktop application. The library
manager is a server you host yourself. There is no hosted version and there will
not be one — see [the note on terms of service](#a-note-on-terms-of-service).

### Which iPods

| Model | Status |
|---|---|
| iPod Classic 6th and 7th gen | Tested on real hardware. Needs a signed database, which the local app writes |
| iPod Video 5th gen | Supported. No database signature required |
| iPod Nano 1st–3rd gen | Supported by the same database format; not tested on hardware |
| Nano 4th gen and later, Touch, iPhone | **Not supported** |

### What you need

- **For the server:** any machine with Docker and Docker Compose. It idles at
  well under 512MB of RAM. No GPU, no media storage — the server never holds
  audio.
- **For syncing:** a Windows computer with a USB port. A prebuilt `.exe` is on
  the [releases page](../../releases); it bundles ffmpeg and needs nothing
  installed. macOS and Linux run from source (Python 3.11+).
- **No API keys.** Deezer, iTunes and MusicBrainz are all used without an
  account. MusicBrainz asks only for a contact address so it can identify the
  client.

---

## Two halves, one repository

| | [`web/`](web/) | [`local/`](local/) |
|---|---|---|
| What | Library manager and API | The sync app |
| Runs | On your server, continuously | On the computer with the iPod, occasionally |
| Built with | Node 22, Postgres, Docker | Python 3.11+ |
| Ships as | A Docker image | A single executable |
| Holds | Library data | Nothing permanently |
| **Touches audio** | **Never** | Downloads, tags, writes, then deletes |

They are separate deliverables with separate release cycles, and they are in one
repository on purpose: they share a contract. The sync manifest is defined by
`web/` and consumed by `local/`, so a change to it is a single commit that CI can
test as a whole — rather than two changes in two repositories with nothing
keeping them in step.

### Why the split exists at all

Browsers cannot see USB devices, so a pure web app has no way to detect an iPod
or write to it. And the person curating a library on their phone is usually not
sitting at the computer with the iPod attached.

The consequence worth stating plainly: **the server stores no audio.** It holds
track, album and artist metadata, playlists, import history and followed
artists. There is no column anywhere in its schema for an audio file. All
downloading happens on the machine that owns the iPod, and every downloaded file
is deleted once the transfer is confirmed.

---

## Setting up your own instance

Everything below assumes a machine with Docker and Docker Compose, and a shell
on it. It takes about ten minutes.

### 1. Get the code

```bash
git clone https://github.com/mangogithib/syncmypod.git
cd syncmypod/web
```

### 2. Write the configuration

```bash
cp .env.example .env
```

Two values are required and ship empty. Generate them rather than inventing
them — this fills both in place:

```bash
sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|; \
        s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
```

Every other setting has a working default and is documented in the file.

`SESSION_SECRET` signs session cookies. Changing it later logs everyone out;
losing it is harmless beyond that. `DB_PASSWORD` is only reachable inside the
compose network, but it is still a password — do not reuse one.

### 3. Start it

```bash
docker compose up -d --build
```

The database migrations run automatically on every start, and are idempotent.

### 4. Create your account

Open the instance (step 5) and the first screen offers to create the owner
account. That form appears only while the database holds no users, so it cannot
be used to sign up against an instance that is already set up — there is no
public registration, by design.

If you would rather do it from the command line, or you have locked yourself
out:

```bash
docker compose exec app npm run create-user -- yourname
```

Omit the password and a strong one is generated and printed. Run it against a
username that already exists and it resets that password and signs out every
session.

### 5. Open it

By default the server binds to **loopback only** (`127.0.0.1:3010`), which means
it is reachable from the machine it runs on and nowhere else. That is deliberate:
the safe default is the one that is safe before you have thought about it.

Pick how you want to reach it:

| You want | Do this |
|---|---|
| Just this machine | Nothing. Open `http://127.0.0.1:3010` |
| Your home network | Set `BIND_ADDR=0.0.0.0` in `.env`, restart. **Only on a network you trust** — this is plain HTTP |
| A private network overlay (Tailscale, WireGuard, ZeroTier) | Set `BIND_ADDR` to that interface's address. The overlay provides the encryption |
| The public internet, with a proxy you already run | Leave `BIND_ADDR=127.0.0.1`, point your existing nginx/Caddy/Traefik at `127.0.0.1:3010`, and set `PUBLIC_URL` and `TRUST_PROXY` (see below) |
| The public internet, no proxy yet | Use the bundled Caddy profile — see [`web/README.md`](web/README.md) |

If anything sits in front of the app, set both:

```ini
PUBLIC_URL=https://pod.example.org        # the address people actually type
TRUST_PROXY=172.16.0.0/12                 # the proxy's network, NOT "true"
```

`TRUST_PROXY` decides whose `X-Forwarded-For` is believed. Setting it to a
specific network rather than blanket-trusting everything is what stops a client
from spoofing its own address past the rate limiter.

The bundled Caddy profile obtains a real certificate over the DNS-01 challenge,
so it needs no inbound port 80 or 443 — useful when those are already taken. It
ships with the DuckDNS provider compiled in; another DNS host means changing one
line in [`web/caddy/Dockerfile`](web/caddy/Dockerfile) and rebuilding. You do not
have to use it at all: any reverse proxy works.

### 6. Pair the computer with the iPod

Download the app from the [releases page](../../releases), unzip it anywhere,
and run `SyncMyPod.exe`. Then in the web interface go to **Devices → Pair a
computer**, and type the server address and the eight-character code into the
app.

Your account password is never typed into the app and never stored on that
machine. The pairing code becomes a device token, which you can revoke
independently at any time.

From source instead:

```bash
cd local
pip install -e .
syncmypod pair https://pod.example.org ABCD1234
syncmypod sync --dry-run
```

---

## Day to day

### Adding music

**Search** finds songs, albums and artists across the metadata providers; adding
one stores its resolved metadata, never a source's own. **Import** takes a
playlist link from Deezer, Spotify, Apple Music, YouTube or YouTube Music and
recreates it. **Sources** follows a playlist so anything added to it later
arrives here too.

### The one rule

A download source's own metadata is never trusted. YouTube uploads routinely
collapse several artists into one field, or amount to little more than a video
title, so every track is re-tagged from a real catalogue before it reaches the
iPod. A track nothing can confirm is written **title-only** rather than tagged
from a guess — an empty field you can see and fix beats a filled one you have to
notice is wrong.

### Syncing

Open the app, press Sync. It works out what is missing, downloads four tracks at
a time, tags each from the server's metadata, writes them to the iPod, and
deletes every downloaded file afterwards.

It never removes music it did not put there. Tracks already on the device are
recognised rather than downloaded again, and files it only recognised are never
candidates for deletion.

### Backups

Two separate things, both worth knowing about.

**The server** keeps everything in Postgres, so one dump is a complete backup:

```bash
docker compose exec -T db pg_dump -U syncmypod syncmypod > syncmypod-backup.sql
```

**The iPod's database** is snapshotted before every sync, because rewriting it is
the one operation that can leave a device unusable. Snapshots are small — the
database files only, not the music — and the last ten are kept:

```bash
syncmypod snapshots              # what is held for the attached iPod
syncmypod restore db-20260918T101500Z
```

`syncmypod sync --full-backup` snapshots every file on the device instead. It is
a genuine preservation copy and it re-reads the whole iPod each run, so it is a
deliberate choice rather than the default.

### Upgrading

```bash
cd syncmypod && git pull
cd web && docker compose up -d --build
```

Migrations apply on start and re-running them is a no-op. Update the local app by
downloading the current release; it checks the manifest version at startup and
refuses to run against a server it does not understand rather than guessing.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| The iPod shows an empty library after a sync | The database signature was wrong for the model. Restore a snapshot (`syncmypod snapshots`) and open an issue with the model number from `syncmypod devices` |
| Downloads fail with `403 Forbidden` partway through | YouTube has rate-limited the machine. Wait, then try again; lower `--at-once` if it recurs |
| Songs sync but have no cover on the device | The catalogue had no artwork for them. The Library page shows which |
| A song will not sync at all | Its metadata is unconfirmed, so it is excluded by design. Fix the artist and album in the web interface, or paste a source link for it |
| Windows Defender quarantines the download | A false positive every unsigned PyInstaller build attracts. Code signing is the real fix and it costs money |
| `syncmypod status` says the token was rejected | The device was revoked, or the server was reinstalled. Pair again |

---

## Working in this repository

Each half is self-contained — its own dependencies, its own tests, its own
build. Nothing in `web/` imports from `local/` or the reverse; the only thing
crossing the boundary is the HTTP contract in `docs/`.

```bash
# The web tool
cd web && docker compose up -d --build

# The local app's test suite, in a container so no local Python is needed
cd local
docker build -f Dockerfile.dev -t syncmypod-local-dev .
docker run --rm -v "$PWD:/app" syncmypod-local-dev pytest
```

The Python suite runs against pyPodLib's simulated iPods, so the database writer
is genuinely exercised rather than mocked. CI runs per directory: a change under
`web/` does not run the Python suite, and a change under `local/` does not
rebuild the server image.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and
[SECURITY.md](SECURITY.md) to report a vulnerability.

### Where to read next

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works and why — data model, resolution, security, the sync protocol |
| [`docs/LOCAL_APP_API.md`](docs/LOCAL_APP_API.md) | The contract between the two halves |
| [`web/README.md`](web/README.md) | Running and configuring the server |
| [`local/README.md`](local/README.md) | Using the sync app |

### Releases

Tags are prefixed, because "v0.2.0" of a two-part repository is ambiguous:

```
web-v0.2.0      a release of the server
local-v0.2.5    a release of the sync app
```

The one number that ties them together is the **manifest version**, declared by
the server in every manifest and checked by the local app at startup.

---

## Licence

MIT — see [LICENSE](LICENSE).

The local app uses [pyPodLib](https://github.com/La22e/pyPodLib) (MIT),
extracted from [iOpenPod](https://github.com/TheRealSavi/iOpenPod) (MIT), whose
iTunesDB engine is what makes writing to an iPod possible at all. Windows builds
bundle [ffmpeg](https://ffmpeg.org) (LGPL/GPL, see
[`local/scripts/fetch_ffmpeg.py`](local/scripts/fetch_ffmpeg.py) for the exact
build and its licence).

## A note on terms of service

Downloading audio from streaming platforms generally breaches their terms. This
design keeps that entirely within your own instance and your own machine — no
audio passes through the server, and there is no hosted version to share the
question with — but it does not make it someone else's problem. Run your own
instance and make your own call.
