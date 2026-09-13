# SyncMyPod

A self-hosted music library manager for classic and clickwheel iPods.

Manage your catalogue, playlists and followed artists from any browser. A small
app on the computer the iPod is plugged into does the actual downloading and
syncing.

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
`web/` and consumed by `local/`, so a change to it should be a single commit that
CI can test as a whole — rather than two changes in two repositories with
nothing keeping them in step.

That contract is [`docs/LOCAL_APP_API.md`](docs/LOCAL_APP_API.md), and it lives
at the root because it belongs to neither half.

### Where to read next

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works and why it is built this way — data model, resolution, security, the sync protocol |
| [`docs/LOCAL_APP_API.md`](docs/LOCAL_APP_API.md) | The contract between the two halves |
| [`HANDOVER.md`](HANDOVER.md) | Project state, decisions already made, traps discovered, what is next |
| [`web/README.md`](web/README.md) | Running and configuring the server |
| [`local/README.md`](local/README.md) | Using the sync app |

### Why the split exists at all

Browsers cannot see USB devices, so a pure web app has no way to detect an iPod
or write to it. And the person curating a library on their phone is often not
sitting at the computer with the iPod attached.

The consequence worth stating plainly: **the server stores no audio.** It holds
track, album and artist metadata, playlists, import history and followed
artists. There is no column anywhere in its schema for an audio file. All
downloading happens on the machine that owns the iPod, and every downloaded file
is deleted once the transfer is confirmed.

---

## Getting started

**Run the server** — see [`web/README.md`](web/README.md).

```bash
cd web
cp .env.example .env      # set DB_PASSWORD and SESSION_SECRET
docker compose up -d --build
```

**Then pair a computer** — see [`local/README.md`](local/README.md).

```bash
cd local
pip install -e .
syncmypod pair https://your-server:8444 ABCD1234
```

---

## Status

| | |
|---|---|
| Library, search, playlists, artists | Working |
| Metadata resolution (Deezer → iTunes → MusicBrainz → YouTube Music) | Working — no API keys anywhere |
| Import a playlist link | Working — Deezer, Spotify, Apple Music, YouTube, YouTube Music in one box |
| Import a pasted list | Working — dash, tab and CSV shapes |
| Follow an artist, with back catalogue | Working — optional, imported in the background |
| Combined search, artist and album pages | Working — browse before adding |
| Tracks the sync could not fetch | Shown on the overview and filterable in the library |
| Device pairing and the sync API | Working |
| Public HTTPS with an automatic certificate | Working |
| Local app: pairing, device detection | Working — nothing needs a terminal |
| Local app: the sync engine | Working on real hardware, including a blank restored iPod |
| Local app: four downloads at a time | Working — the device write stays serialised |
| Local app: playlists on the device | Working — written to the dataset the iPod reads |
| Local app: album art on the device | Working — tags and the iPod's own artwork database |
| Local app: YouTube sign-in | Working — opens a browser of its own where reading one is impossible |
| Local app: cancel and eject | Working — stops at a track boundary, then unmounts safely |
| Packaging to a downloadable app | Working — Windows, built and released by CI |

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

CI runs per directory: a change under `web/` does not run the Python suite, and
a change under `local/` does not rebuild the server image. See
[`.github/workflows`](.github/workflows).

### Releases

Tags are prefixed, because "v0.2.0" of a two-part repository is ambiguous:

```
web-v0.2.0      a release of the server
local-v0.1.0    a release of the sync app
```

The one number that ties them together is the **manifest version**, declared by
the server in every manifest and checked by the local app at startup. A local
app that meets a manifest version it does not understand refuses to run and says
so, rather than guessing at a field whose meaning may have changed.

---

## Licence

MIT — see [LICENSE](LICENSE).

The local app uses [pyPodLib](https://github.com/La22e/pyPodLib) (MIT),
extracted from [iOpenPod](https://github.com/TheRealSavi/iOpenPod) (MIT), whose
iTunesDB engine is what makes writing to an iPod possible at all.

## A note on terms of service

Downloading audio from streaming platforms generally breaches their terms. This
design keeps that entirely within your own instance and your own machine — no
audio passes through the server — but it does not make it someone else's
problem. Run your own instance and make your own call.
