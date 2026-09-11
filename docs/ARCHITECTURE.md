# Architecture

How SyncMyPod works, and why it is built this way.

[README.md](../README.md) covers what it is and how to run it.
[HANDOVER.md](../HANDOVER.md) covers project state and what comes next. This
document is the design.

---

## The premise

Two components, one hard rule between them:

> **The server holds library data. The local app holds audio, briefly.**

There is no column anywhere in the server's schema for a file path, a byte, or a
stream URL of actual music. That is not an oversight to be fixed later — it is
the constraint the whole design is arranged around. It keeps the server light,
means it hosts no media, and keeps every download on the machine that owns the
iPod.

```
   Browser                  Server (web/)                 Local app (local/)
   ───────                  ─────────────                 ──────────────────
   curate library  ───────▶ catalogue + playlists
                            resolved metadata
                                   │
                                   │  manifest: what SHOULD be on the iPod
                                   │  (no audio, no download URLs)
                                   ▼
                                                          find the audio
                                                          re-tag from manifest
                                                          transcode if needed
                                                          write to iPod  ──▶ 🎵
                                                          delete downloads
                                   ▲                             │
                                   └──── results: what landed ───┘
```

---

## Part 1 — The web tool

Node 22, Postgres 16, Docker. Two npm dependencies (`express`, `pg`). The
frontend is vanilla ES modules with no bundler.

### Data model

The central distinction: **the catalogue is shared, the library is per-user.**

```
artists ──┐
albums  ──┼── tracks ──── library_tracks ──── users
          │      │              │
          │      │              └── playlist_tracks ── playlists
          │      └── track_artists (ordered, with roles)
          └── (album_artist_id)
```

`artists`, `albums` and `tracks` are resolved facts about music that exist
independently of who wants them, deduplicated globally. What a given user
actually wants on their iPod lives in `library_tracks` and `playlists`. A
self-hosted instance usually has one user, but building it this way cost almost
nothing and avoids a painful migration later.

**Multi-artist tracks get real rows.** `track_artists` is ordered and carries a
role (`primary` / `featured` / `remixer`). This is the specific failure the
concept set out to fix: raw download-source metadata routinely collapses several
artists into one string. `tracks.artist_credit` holds the joined string that
gets written to the iPod tag, so the convention is decided once, server-side,
rather than independently by every consumer.

#### Identity and deduplication

Every catalogue row has a `match_key` with a unique constraint. It is the
strongest identity available, in a **fixed** order:

```
isrc:<ISRC>  >  dz:<deezer>  >  it:<itunes>  >  mb:<musicbrainz>  >  n:<name>
```

ISRC leads because it is the one identifier that survives crossing between
services. Without it, the same recording found via Deezer and later via iTunes
would key as `dz:123` and `it:456` and become two catalogue rows — and therefore
two entries on the iPod. The order is fixed rather than "whichever provider
answered", so a record carrying two ids always produces the same key.

Albums and artists have no ISRC equivalent, so cross-provider duplicates remain
possible there where names differ in punctuation. The name fallback catches most
of it. This is a known, tolerable imperfection.

#### The metadata gate

`tracks.metadata_state` decides whether a track may reach a device:

| State | Meaning | Syncs? |
|---|---|---|
| `pending` | Never resolved | No |
| `unresolved` | Resolution ran, found nothing good enough | No |
| `resolved` | Matched to a provider record | Yes |
| `manual` | A human corrected it | Yes |

This is the enforcement point for the project's central rule. An unresolved
track appears in the library, flagged, and is reported in the manifest's
`excluded` list — it is never silently dropped, and never silently written to an
iPod with an unverified tag.

`manual` is sacred: automated resolution will not overwrite it without an
explicit `overwriteManual` flag.

### Metadata resolution

Whatever a track claims to be, it is re-resolved against a real catalogue before
anything is written to an iPod.

**Three providers, in a fixed order, ranked by how much structure each returns**
— not by catalogue size, because structure is what this design protects:

| | Artist structure | ISRC | Track no. | Cost |
|---|---|---|---|---|
| **Deezer** | Ordered contributors | Yes | Yes | ~150ms |
| **iTunes** | One joined string | No | Yes | ~3s (rate limit) |
| **MusicBrainz** | Ordered credits | Yes | Sometimes | ~1s |

None needs an account or a key. A provider that is off or unconfigured is
skipped, so the chain degrades rather than breaking.

**Three tiers, strongest first:**

1. **ISRC lookup.** An exact identifier for a specific recording. A hit needs no
   scoring — it is definitionally the right track.
2. **Structured search** on title, artist and album, with every candidate
   scored. Anything below the acceptance threshold is rejected rather than
   silently accepted.
3. **Loose title-only search**, for when the source metadata was so poor the
   artist was embedded in the title (`Artist - Title (Official Video)`).

#### Candidate scoring

```
score = title×0.50 + artist×0.30 + duration×0.12 + album×0.08
        − qualityPenalty
        + positionBonus            (capped at 0.02)
```

Accepted at **0.62**; suggested to the user at **0.35**. Similarity is token-set
Dice coefficient, which is robust to word order and to one side carrying extra
words.

Three details that each came from a real failure:

- **Decorations are stripped from both sides.** Stripping only the query meant a
  soundtrack entry titled `Kesariya (From "Brahmastra")` scored 0.5 against the
  query `Kesariya`, while an unrelated single simply titled `Kesariya` scored
  1.0 — so the generic single won on having a *less* precise title.
- **`qualityPenalty`** lets a provider report that a candidate is a poor
  representation — a bootleg or a live take. MusicBrainz models every live
  performance as its own recording, so a well-known song returns the studio take
  buried among identically-titled bootlegs that score identically on text alone.
- **`positionBonus`** preserves the provider's own popularity ordering, which
  the scorer otherwise discarded. A song and its remix tie on title and artist,
  so with no duration to compare the winner came down to iteration order. Capped
  an order of magnitude below the weakest real signal, so it decides ties and
  never overrides evidence.

#### Hydration

Deezer's search endpoint is cheap but returns only the primary artist; its
`/track` endpoint returns the full ordered contributor list and the ISRC.
Fetching that for every candidate would multiply the request count, so the
resolver hydrates **only the winner** — roughly one extra request per resolved
track rather than one per candidate considered.

#### Why iTunes artists are never split

iTunes returns `"Pritam, Arijit Singh & Amitabh Bhattacharya"` as one string.
Splitting on `, ` and ` & ` works most of the time, and that is exactly the
problem: the failure is silent and permanent. `"Earth, Wind & Fire"` becomes
three artists, `"Simon & Garfunkel"` becomes two, and nobody notices until the
iPod shows artists that never existed. The joined string is already what the tag
wants, so it is kept whole and Deezer is preferred where real structure matters.

### Configuration

Provider settings live in the `app_settings` table and are editable on the
Settings page, taking effect on the next request with no restart. Environment
variables **take precedence** when set, and the UI shows such values as locked,
naming the variable — rather than accepting an edit and appearing to lose it.

Reads are synchronous from an in-memory cache loaded at boot and refreshed on
write, because `isEnabled()` is called from route handlers, the health check and
the resolver's hot path. Secrets are never returned to the browser — only
"is set" and a short prefix — and a blank secret field on submit means "keep the
stored value", so saving a form cannot wipe a secret the user did not retype.

### Security model

- **Passwords**: scrypt (N=2¹⁵) from Node's own crypto — no native dependency.
  Parameters travel with the hash, so they can be raised later without
  invalidating existing passwords.
- **Sessions**: server-side rows, so revocation is one `DELETE`. Cookie is
  `HttpOnly`, `SameSite=Lax`, and `Secure` only when the connection really is
  HTTPS — setting it otherwise makes browsers silently drop it and login appears
  to do nothing.
- **Device tokens**: stored as SHA-256 hashes, shown once. Hashed with plain
  SHA-256 rather than a KDF deliberately — the token is 256 bits of randomness,
  so there is no dictionary to attack, and every request from the local app
  would otherwise pay a ~100ms cost.
- **Password change revokes browser sessions but *not* device tokens.** The two
  are independent by design: changing a password should not break a working sync
  on another machine.
- **Two separate auth paths.** The device API accepts only bearer tokens, never
  a session cookie. A CSRF against the web UI cannot reach a sync endpoint, and
  a leaked device token cannot change the account password.
- **XSS is removed as a category**, not defended against: the frontend's `h()`
  helper sets all text through `textContent`, so nothing from a provider API or
  an input can be interpreted as markup.
- **`TRUST_PROXY` takes a CIDR list, not a hop count.** The app is reachable
  both through the proxy and directly on its published port; a hop count cannot
  tell those apart and would let any client spoof `X-Forwarded-For` past the
  login rate limiter.

### Deployment

Self-contained Compose stack — own network, own volume, own Postgres. Shares
nothing with anything else on the host.

An optional `public` profile adds Caddy with a real Let's Encrypt certificate,
off by default because "reachable from the internet" should be a deliberate
switch. It uses the **DNS-01** challenge rather than HTTP-01, which needs no
inbound port at all — that is what makes it work on a host where 80 and 443 are
already taken, and means the certificate can be issued before a port is opened.

Static assets are served `Cache-Control: no-cache`. There is no bundler and so
no content-hashed filenames; without it a rebuild leaves browsers running the
previous frontend against the new backend.

---

## Part 2 — The sync manifest

The contract between the two halves, specified in
[LOCAL_APP_API.md](LOCAL_APP_API.md).

**It is** a complete statement of what the iPod should contain — track metadata,
artwork URLs, playlist membership and order.

**It is not** audio, or a link to audio the server has. There is deliberately no
download URL. `searchTerms` is what the local app searches a source with, and it
is built from *resolved* metadata, never from the original source title.

```json
{
  "manifestVersion": 1,
  "conventions": { "artistJoin": ", ", "retagFromManifest": true },
  "tracks": [{
    "id": 1,
    "title": "Second Sunrise",
    "artist": "Aurora Kane, Minor Waves",
    "artists": [
      { "name": "Aurora Kane", "role": "primary",  "position": 0 },
      { "name": "Minor Waves", "role": "featured", "position": 1 }
    ],
    "searchTerms": { "primary": "Aurora Kane, Minor Waves - Second Sunrise" },
    "deviceState": "synced"
  }],
  "playlists": [{ "name": "Morning Drive", "trackIds": [3, 2, 1] }],
  "excluded":  [{ "title": "Halfway Down", "metadataState": "unresolved" }]
}
```

`artist` is the string to write to the tag; `artists` is the structured truth.
`playlists[].trackIds` is already ordered and already filtered, so the local app
never has to handle a dangling reference. `excluded` reports what could not be
synced and why.

**Versioning.** The server states `manifestVersion` in every manifest and the
local app declares which versions it understands. A local app meeting an unknown
version **refuses to run** and says so. Misinterpreting a field writes wrong tags
to an iPod, which is worse than stopping.

### A sync run

```
hello ──▶ report device ──▶ manifest ──▶ diff ──▶ open run
                                                     │
                        ┌────────────────────────────┤
                        ▼                            │
              download, re-tag, write                │
                        │                            │
                results (incrementally) ─────────────┤
                        │                            │
                        ▼                            │
                 write playlists                     │
                        │                            │
                 prompt before removals              │
                        │                            │
                  finish run ◀──────────────────────┘
                        │
                  delete downloads
```

Results are reported **incrementally**, not once at the end, so a sync
interrupted halfway still records what landed and the next run does not
re-download it. The server records what the local app reports and never verifies
it — it cannot see the iPod. The local app is the authority on what is
physically on the device.

---

## Part 3 — The local app

Python 3.11+. The CLI and the GUI are two front ends over one engine — the GUI
serves a page to the local browser and renders the same progress events the
terminal prints, so neither can drift from the other.

### Module layout

| Module | Responsibility |
|---|---|
| `cli.py` | Subcommands, exit codes, human-readable errors |
| `config.py` | Where the token, server address and backups live on disk |
| `api.py` | The server's device API |
| `device.py` | iPod detection and iTunesDB access — **imports pyPodLib** |
| `sync.py` | Orchestration: plan, run, report, clean up |
| `downloader.py` | Finding and fetching audio with yt-dlp |
| `tagging.py` | Writing the manifest's metadata onto the file, with mutagen |
| `transcode.py` | Making a file the device can play — **imports pyPodLib** |
| `ledger.py` | The record, kept on the iPod, of what this tool put there |
| `tagging.py` + `device.py` | Album art: into the file's tags, then into the device's own artwork database |
| `workspace.py` | The scratch directory, and its guaranteed removal |
| `ffmpeg.py` | Finding ffmpeg — bundled copy first, then PATH |
| `youtube.py` | The saved YouTube session, and what bitrate it unlocks |
| `gui/` | A localhost server and one page, over the same engine |

### The diff

The manifest reports what the server *believes* is on the device, as
`deviceState`. It is a starting point, not evidence: the server cannot see the
iPod, and the user may have used iTunes, deleted tracks, or restored the device
between two syncs.

So the real diff is made against the iPod's own database, and the link between a
library track and a database row is written down in
`iPod_Control/Device/SyncMyPod.json` — on the iPod rather than on the computer,
so syncing from a second machine continues one history instead of starting a
second. Where that record has nothing to say, a track is matched on title,
artist and album, which is what lets a first sync to an iPod that already holds
the library adopt its contents rather than duplicate them.

The consequence that matters most: **a track this tool did not add can never be
removed by it.** An iPod may hold years of music put there by something else.

### Artwork

Album art lives in **two** places on an iPod and both are needed.

The file's own tags are what a computer reads, and `tagging.py` writes those
from the manifest's `artworkUrl`. The *device* reads something else entirely: a
separate database of pre-scaled RGB565 images in `iPod_Control/Artwork`, an
`ArtworkDB` plus one `.ithmb` per size. Art embedded in a file but absent from
that database is **invisible on the iPod's screen** — which is
indistinguishable, from the user's side, from the feature not working.

pyPodLib writes both, and does it atomically with the iTunesDB. The subtlety is
which tracks to hand it: it converges the whole device, so a track it is given a
source file for has its art rebuilt, and a track it is *not* given one for keeps
whatever it already had. Only the tracks in the ledger are passed. Handing it
everything would re-encode art this tool never wrote, and clear it outright for
any track whose file has no embedded cover but whose art came from iTunes.

"Missing cover art" counts as work to do, so a library synced before this
existed picks it up without re-downloading a byte. A track is only counted as
missing if its database row points at no image — and that row heals itself,
because the parser re-links tracks from the `ArtworkDB`'s own song ids.

### Audio quality

There is no quality setting, and that is the design rather than an omission.

Signed out, YouTube offers exactly one AAC stream at roughly 128kbps. A YouTube
Music Premium account is offered a second at 256kbps. There is nothing else to
choose between, so the whole policy is one yt-dlp format expression —
`bestaudio[ext=m4a]/...` — which resolves to whichever of the two the account
is entitled to. A bitrate menu would have offered numbers that no source can
supply, and encoding a 128kbps download at 256 produces a larger file holding
identical sound.

Signing in means borrowing a browser's session, because YouTube decides what to
offer from the request's cookies and there is no API for it. **Only
youtube.com cookies are saved**: yt-dlp's YouTube extractor calls
`_get_cookies('https://www.youtube.com')` and nothing else, so keeping a whole
browser jar would put every other signed-in session on disk for no benefit.
`google.com` is dropped with the rest, which is the difference between a file
that grants YouTube access and one that grants a Google account.

What gets reported is measured, not asserted: a signed-in account without
Premium is indistinguishable from no account at all, so `youtube.check()` asks
what bitrate is actually on offer and shows that.

### Conversion

Delegated to pyPodLib rather than driven directly, which is why `transcode.py`
is the second module importing it.

"An iPod cannot play Opus, so convert Opus to AAC" is about a third of the rule.
A clickwheel iPod also refuses AAC that is not Low Complexity — the HE-AAC a
source may return plays as silence — and refuses sample rates above 48kHz and
24-bit depth, and the limits differ by model. pyPodLib already encodes all of
that, keyed to the device currently open.

The common case does no conversion at all: the downloader asks YouTube for the
AAC stream before the Opus one, so the file usually arrives already playable.
Re-encoding a lossy source into another lossy format is pure loss.

### Why pyPodLib is quarantined

It is the right library: MIT, extracted from iOpenPod, and the only open-source
implementation covering the database signatures a post-2007 iPod requires. It is
also `0.1.0`, alpha, with a single release — and it is what rewrites the database
the iPod boots from.

So it is pinned to an exact version, and everything outside `device.py` and
`transcode.py` talks to this project's own `IpodDevice` type. Replacing or
forking it changes two files, both small. The import is deferred into the
functions that need it, so a broken install produces a clear message from
`syncmypod status` rather than a traceback at startup.

### Database signatures

The one fact that differs meaningfully between target devices:

| Device | Scheme |
|---|---|
| iPod 5th gen (Video), Nano 1–3 | `NONE` |
| iPod Classic 6th/7th gen, Nano 4+ | `HASH58` |
| iPhone-OS-era devices | `HASH72`, `HASHAB` |

Get it wrong and the iPod boots to an **empty library with every file still on
disk** — the most confusing possible failure. So the scheme is read from the
device rather than inferred, and anything unrecognised is treated as *requiring*
a signature. The two mistakes are not symmetrical: signing unnecessarily is
harmless.

### Testing without hardware

pyPodLib can simulate **204 iPod models**, including both targets. The test suite
runs against simulated devices rather than mocks, so the device layer is
genuinely exercised — a mock would only assert that the code matches my
assumptions about the library, rather than the library itself.

```python
device.create_virtual(path, "MC297")   # Classic 7th gen — HASH58
device.create_virtual(path, "MA146")   # Video 5th gen   — NONE
```

Tests needing real hardware are marked `@pytest.mark.hardware` and excluded by
default.

### Safety

Four properties, in the order they matter.

**Every run takes a backup before writing.** Writing a database is the one
operation that can leave a device unusable, and the library is alpha, so a
restore point costs a moment and removes the worst outcome. A backup that cannot
be taken stops the sync rather than being skipped.

**Nothing this tool did not add is ever removed.** See the diff, above.

**An interrupted run leaves a device that still works.** Results are reported to
the server as they happen rather than at the end, and the database is committed
every few tracks rather than once — so a sync that loses its network, or is
cancelled, keeps what it had already written and the next run resumes. Cancelling
takes effect between tracks, never part-way through a database write.

**Nothing downloaded outlives the sync.** Each track's files are deleted as soon
as it is on the device, the workspace goes when the run ends however it ends, and
a workspace orphaned by a process that was killed outright is removed by the next
run.

---

## Repository layout

```
README.md              what it is, how to run it
HANDOVER.md            project state, decisions, what is next
LICENSE                MIT, covers both halves
docs/
  ARCHITECTURE.md      this document
  LOCAL_APP_API.md     the contract between the halves
web/                   the server
  server/              routes, services, providers, migrations
  public/              frontend — no build step
  caddy/               optional TLS proxy, DNS-01
local/                 the sync app
  src/syncmypod_local/
  tests/               runs against simulated iPods
.github/workflows/     path-filtered CI, one per half
```

`docs/` sits at the root because `LOCAL_APP_API.md` is the agreement *between*
the halves and belongs to neither. Nothing in `web/` imports from `local/` or the
reverse — the only thing crossing the boundary is HTTP.
