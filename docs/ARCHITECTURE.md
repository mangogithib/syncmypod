# Architecture

How SyncMyPod works, and why it is built this way.

[README.md](../README.md) covers what it is and how to set it up.
[LOCAL_APP_API.md](LOCAL_APP_API.md) is the contract between the two halves.
This document is the design.

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

### Standing sources

A **source** is a playlist link somewhere else that this library follows. An
import happens once; a source is re-read on a half-hour timer and whatever is
new is added.

It used to be re-read only when somebody opened the Sources page, which put the
whole mechanism behind a page visit — a playlist that keeps up with another one
has to keep up whether or not anyone is looking at the page it is configured
on. Followed artists have had a timer since the beginning; this is the same
idea for playlists.

A source can be pointed at a playlist **here**, so everything it ever brings is
appended to one that already exists rather than to a second playlist named
after the source. The column had always been there and nothing could set it.

Sources are additive: a track removed upstream stays, and removing a source
keeps everything it brought. Same reasoning as the local app's ledger — "it
disappeared from my library" is a far worse failure than "it is still there".

### The same song, twice

A track nothing could identify is keyed on its name, because there is nothing
stronger to key it on. The same recording arriving later with an ISRC is keyed
on that. Two keys, two rows, and nothing reconciles them — so a library quietly
holds some songs twice.

**It shows up on the iPod rather than in the web tool.** The unresolved row
carries its own album string, lifted from a video title, so one album becomes
two on the device with the songs split between them — and that row has no
`albums` row to appear under in the Albums list. The first anybody knows of it
is a duplicate cover in Cover Flow.

**Two rows with one title are not automatically a fault.** This distinction is
the whole design here, and getting it wrong the first time cost a feature.
"Dekha Hi Nahi" is on a 2024 album and again as a 2025 duet; "Kagaz" is on a
studio release and on a session record. Different ISRCs, different lengths,
different credits — two recordings, and a library holding both is a library
that is correct. There is nothing to fix and nothing to ask.

What is worth fixing is only ever the other shape: a **placeholder** beside the
real thing. A placeholder is a row nothing recognised, carrying a title
somebody typed into a video description. It is not a claim about a different
recording, it is the absence of a claim — so `identifiedTwin` folds it into the
one resolved row that shares its title, during the re-match pass, without
asking.

Four conditions, each doing work:

| Condition | What it rejects |
|---|---|
| The twin is `resolved` | two placeholders merging into each other |
| Normalised titles match exactly | a song against its reprise or unplugged cut |
| Placeholder has no artist, or shares a name | a cover — "Kagaz" by someone else keeps no name in common |
| Exactly one candidate | two identified rows with one title, which is not a fault |

Artist names are compared as **token sets**, because the two sides never agree
on spelling: the same song arrived once as `Garvit Priyansh,Jonita,Aniket` and
once as `Garvit-Priyansh, Priyansh Srivastava, Jonita Gandhi, Garvit Soni,
Aniket Shukla`. Words of three letters or fewer are dropped — an initial or
"the" matching is not evidence.

The ordinary route is preferred and runs first: if the catalogue can identify
the placeholder, `saveResolvedTrack` returns the identity's row and the merge
happens on evidence rather than on a title. Either way the move is `absorb` —
library membership, playlist places and what a device is holding go onto the
kept row before the other is deleted, so nothing is lost and the next sync
re-downloads nothing.

**There is no duplicates review, and there was briefly.** It listed every pair
of rows sharing a title and asked which to keep. On the first real library it
found four: two placeholders, and two pairs of genuine separate releases. Half
of what it asked had a right answer the tool could work out, and the other half
had no answer to give — so it was asking the user to authorise work in one case
and to confirm a non-problem in the other. Both halves are better handled by
not asking.

### What decides an album on the device

The album string, and the album artist beside it. Both are grouping keys, and
both have been got wrong.

**The manifest sends the resolved album name**, `coalesce(al.name, album_credit)`
— not the raw credit. The credit is an unverified string and `albums.name` is
the resolved fact, which is the rule the whole design rests on; it also means a
track carrying a different spelling of its own album cannot become a second
album on the device.

**A multi-artist album is written as a compilation.** An iPod groups its browse
lists by album *and artist*, and an album artist does not override that — a
soundtrack whose ten tracks named ten singers, with one album artist on every
one of them, showed as one album in the Albums menu and as a row of separate
covers in Cover Flow. Measured on a 7th gen Classic: the only field that varied
across the album was the track artist.

The compilation flag is the switch iTunes uses for exactly this, which is why a
various-artists soundtrack carries it there. It was hardcoded `False` here, and
that was half right: source files arrive with it set inconsistently, and one
track of an album carrying it while the others do not scatters the album just as
badly, so forcing a constant fixed a real problem. The mistake was choosing the
constant per track, where nothing knows what the rest of the album looks like.
The server decides it once for the whole album — `count(DISTINCT artist_credit)`
over the user's tracks on it — so it is still constant across an album and now
it is also right. A single-artist album is unaffected.

**An album artist is written only when there is an album.** `tagging.py` used to
fall back to the track artist whenever the manifest carried no album artist.
That is right for a record whose album artist was simply never recorded. It is
wrong for a track on no album at all: those have nothing else to group on, so
the fallback gave fourteen album-less songs fourteen different keys and Cover
Flow drew a separate "Unknown Album" tile for each. Left empty they share one
key and appear once, which is what iTunes itself does.

**And a sync corrects what is already on the device.** A track used to be
tagged from the manifest once, when it was copied across, and never again — so
an artist fixed in the web tool afterwards, or a change to what this
application writes, never reached an iPod that already held the song. The only
remedy was to remove it and download it again.

`_stale_tag_locations` compares the device's own database rows against the
manifest during planning, and a disagreement counts as work in exactly the way
missing artwork does. `_retag_existing` then rewrites those files' tags and
`IpodDevice.retag` corrects the rows, committing once through pypodlib's own
`save`. Four properties make it safe to run on every sync:

- **Only tracks in the ledger**, the same rule removals follow — a track added
  by iTunes keeps its own tags whatever the library says.
- **Only rows that disagree.** A device already in step costs one pass over its
  track list and no writes at all.
- **The cover is read back out and written in again.** `apply` clears every tag
  before writing, which is what stops source metadata surviving; re-tagging
  without `embedded_artwork` would drop the embedded cover, and the artwork
  database is rebuilt by reading covers out of those very files. One pass of
  corrections would have stripped the art off the device.
- **Never fatal.** The music is on the iPod; failing a sync over a tag would be
  the wrong trade.

### Another go at the songs nothing could identify

A track imported from a video list arrives with a title and no artist, and a
title alone is not enough to match on. Those used to sit in the library behind
a notice offering to look them up, which is a chore rather than a choice —
nobody was ever going to answer "no thanks, leave them broken".

**A track reading `manual` with no artist is included in the pass.** `manual` is
sacred because it protects a human's answer, and an empty field is not an
answer. Those rows exist because saving the edit dialog used to set `manual`
whether or not anything changed — so opening a song to look at it exempted it
from every automatic repair there is. A save that changes nothing is no longer
a correction.

So it runs on its own, after every import that left something unresolved. The
reason a second pass finds what the first missed is not cleverness: an import
of three hundred tracks is three hundred provider lookups in a burst, Deezer
and iTunes both rate limit, and a lookup that comes back empty under load is
indistinguishable at the time from a track nothing knows about. The fix for
that is a retry, not a prompt. One pass per user at a time, after a pause, and
with no job row — nothing is watching it.

### Browsing

Search returns songs, albums and artists together by default, because someone
typing a name usually wants whichever of the three it turns out to be, and
being made to pick the category first is a question the search can answer
itself. The three run as independent provider ladders in parallel — they
fail independently, and falling back for one category should not drag the
others onto a weaker source. The single-category filters remain.

An album or artist opens a **page**, from a search result and from the
library's own lists alike. It shows the whole release or discography with what
you already hold marked on it, so every row carries the action that applies to
it — Add when it is missing, Remove when it is yours.

Both halves of that were once missing. A library album with no provider id
opened a dialog listing only the songs already added, so the same record
behaved differently depending on the door you came through and the version
reached from your own library was the less useful of the two. A missing id is
now looked up once, by name and album artist, and written back.

**Identity is matched on the provider id columns, not only on `match_key`.**
The key records the strongest identity a track was resolved under, so a
recording hydrated through Deezer's `/track` endpoint is stored as `isrc:…`
while an album listing — which returns no ISRC — asks about `dz:…`. Neither
matched, so an album page offered to add songs already in the library and could
not offer to remove them. The columns accumulate identities across providers
and answer what the key cannot. Inside one album a title is a reliable key as
well, so the library's own tracks for that album fill any gap left over.

### YouTube, on request

Deezer, iTunes and MusicBrainz cover licensed commercial releases — most music,
and not all of it. Regional releases and small labels are routinely missing, so
a library could not contain them at all. A **Search on YouTube** button under
the song results covers that.

It is deliberately *not* another rung on the resolver's ladder. YouTube
metadata is a video title and a channel name, which is precisely the source this
project exists to distrust; its results are ranked by engagement, so a lyric
video or a remix outranks the original; and the other three answer in about a
hundred milliseconds where this fetches and parses a megabyte of HTML. Making
every search pay that for an uncommon case would be the wrong trade.

A result picked there is added through the ordinary route, so the **resolver
still runs on its title and artist**. A YouTube-found track that also exists on
Deezer is saved properly credited, keeping the video as its `sourceHint`; one
that exists nowhere else is saved `unresolved` and waits to be corrected by hand,
which promotes it to `manual`. Either way the metadata written to the iPod is
never a video title — the gate in the manifest is unchanged.

There is no API key. The Data API v3 needs a Google Cloud project and allows
about a hundred searches a day; the alternative is what every client including
yt-dlp does, which is to read the JSON YouTube embeds in its own search page.
That was measured from the deployment host before being relied on, since
datacentre IPs are treated more harshly than residential ones: it returns a full
result set in about half a second. The cost is that YouTube can change the page,
which is survivable by design — the button returns nothing and the rest of the
search is untouched.

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

Three settings, and the thing they choose is the **encode**, not the download.

There used to be no setting, on the reasoning that YouTube offers one AAC
stream to everybody and a second to Premium, so there is nothing to pick
between. That was true about the download and missed the rest: an iPod cannot
play Opus, the Opus stream is what gets fetched (see *Conversion*), and so
every track is re-encoded on the way across. 128kbps against 256 is a real
trade between space and sound on a device with a fixed disk, and it is the
user's to make.

| Setting | What lands on the iPod |
|---|---|
| `standard` | Opus, re-encoded to 128kbps AAC. About half the space. |
| `high` | Opus, re-encoded to 256kbps AAC. The default. |
| `premium` | YouTube's own 256kbps AAC, written across untouched. |

`premium` is the only one that asks anything of the user, and it is offered
greyed out until a check confirms the account has a subscription — an option
that can be picked and then quietly does something else is worse than one that
says it cannot be picked yet. It degrades to `high` if the subscription lapses,
because the Opus is then the only stream left and 256 is what `high` does to it.

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

**The session is used only when it buys something.** A saved session is carried
on a download if, and only if, the last check found the account has Premium.
That is not caution, it is a reported bug: signing in with an ordinary account
made the probe return no results at all and every track of the sync that
followed failed. A signed-in request is attributable and subject to bot checks
an anonymous one is not, and without Premium the cookies unlock nothing — the
256kbps stream is the only thing they were ever for. So the rule is exactly the
value proposition.

**The session renews itself.** The browser profile that signed in is kept, so
the cookies can be rebuilt from it without a password. Once they are a week old
a sync starts the same profile headless and takes fresh ones — no window, no
typing, and no consequence beyond an anonymous request if it cannot be done.
Headless is right here and wrong for a sign-in: Google will not accept a
password in a browser it can tell is automated, but restoring a session the
profile already holds involves no password at all.

### Conversion

Delegated to pyPodLib rather than driven directly, which is why `transcode.py`
is the second module importing it.

"An iPod cannot play Opus, so convert Opus to AAC" is about a third of the rule.
A clickwheel iPod also refuses AAC that is not Low Complexity — the HE-AAC a
source may return plays as silence — and refuses sample rates above 48kHz and
24-bit depth, and the limits differ by model. pyPodLib already encodes all of
that, keyed to the device currently open. The bitrate is the one part this
project decides, from the setting above.

The one case that does no conversion at all is a Premium account's 256kbps AAC,
which the format ladder prefers and which arrives already playable. Re-encoding
that would be pure loss.

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
README.md              what it is, how to set it up
LICENSE                MIT, covers both halves
CONTRIBUTING.md        how to work on it
SECURITY.md            how to report a vulnerability
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
