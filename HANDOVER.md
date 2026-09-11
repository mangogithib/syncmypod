# Handover

Working context for anyone — human or AI — picking this project up. It covers
what exists, what was decided and why, the traps already discovered, and what
comes next.

For what the tool *is*, read [README.md](README.md). For how it works
internally, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This file is the
project's state and its reasoning.

**Last updated:** 11 September 2026 (sync engine and first GUI)

---

## 1. Where things stand

| Area | State |
|---|---|
| Web library manager | Working, deployed, publicly reachable over HTTPS |
| Metadata resolution | Working — Deezer → iTunes → MusicBrainz, **no API keys needed** |
| Bulk import | Working — pasted track list, public Deezer playlist |
| Followed artists | Working — auto-adds new releases, via Deezer |
| Device pairing + sync API | Working, verified end to end |
| Local app: pair / status / devices | Working, verified against the live server |
| Local app: the sync engine | Working, verified on real hardware |
| Album art on the device | Working — verified by decoding it back off the iPod |
| YouTube Premium sign-in | Working — 256kbps where the account allows it |
| Local app: GUI | First version — status, sync, live progress, cancel |
| Bundled ffmpeg | Fetch script written; binaries are gitignored |
| Packaging to a downloadable app | Working — 174MB zip, built by CI on a tag |
| **Furnishing (visual polish)** | **Not started — this is next** |

Roughly 14,700 lines across 45 JavaScript files, 13 Python modules, 4 SQL
migrations. 165 Python tests, all passing.

### Live instance

| | |
|---|---|
| Public URL | `https://syncmypod.duckdns.org:8444` |
| SSH | `ssh root@100.96.249.123` |
| Public IP | `145.241.202.47` |
| Deploy directory | `/root/syncmypod` |
| Containers | `syncmypod-app-1`, `syncmypod-db-1`, `syncmypod-caddy-1` |
| Certificate | Let's Encrypt, expires 10 Dec 2026, auto-renews |
| Contents | 1 user, 18 tracks, 43 artists, 2 playlists, 3 paired devices |

**Credentials are deliberately not recorded here.** This file is in a git
repository, and repositories get cloned, shared and occasionally made public.
The account is `mo`; reset the password without needing the old one:

```bash
ssh root@100.96.249.123 'cd /root/syncmypod && docker compose exec app npm run create-user -- mo'
```

Secrets live in `/root/syncmypod/.env` on the server (chmod 600) and in the
`app_settings` table. Nothing sensitive is in the repository.

---

## 2. The idea, in one paragraph

A self-hosted music library manager for classic iPods. The web tool holds
library data — track, album and artist metadata, playlists, followed artists —
and **never touches audio**; there is no column anywhere in its schema for an
audio file. A separate local app, running only on the computer the iPod is
plugged into, reads what *should* be on the device, downloads what is missing,
re-tags it from the server's resolved metadata, writes it to the iPod, and
deletes every downloaded file afterwards.

The split exists because browsers cannot see USB devices, and because the person
curating a library on their phone is usually not sitting at the machine with the
iPod attached.

---

## 3. Decisions already made — please don't re-litigate these

Each of these was a real choice with a reason. If one needs revisiting, that is
fine, but start from the reasoning rather than from scratch.

### Product

- **Separate web tool and local app.** Non-negotiable; it is the core premise.
- **One repository, two directories** (`web/`, `local/`). Initially two repos;
  Mohamed asked why, the trade-off was laid out, and he chose the monorepo. The
  deciding argument: the sync manifest is defined by `web/` and consumed by
  `local/`, so a change to it should be one commit that CI tests as a whole.
- **`web/` not `server/`** — the Node app already contains its own `server/`
  directory, and `web/` matches the concept document's vocabulary.
- **CLI before GUI** for the local app. The engine is identical either way, and
  a CLI is testable. Both now exist over the same engine.
- **The GUI is a page served to the local browser**, not a desktop toolkit.
  Mohamed chose this over Tkinter and PySide6. It adds no dependency, keeps the
  packaged executable small, and can use the web tool's own design tokens so the
  two halves look like one product. The cost is that it is a browser tab rather
  than a window, and that `theme.css` now exists in two places that must be kept
  in step.
- **The record of what was synced lives on the iPod**, in
  `iPod_Control/Device/SyncMyPod.json`, not in the computer's config directory.
  An iPod moved between two computers then continues one history rather than
  starting a second, which is the same reasoning as the pairing design. It is
  keyed by server and user, so two accounts can share a device.
- **No audio quality setting, deliberately.** One was built on 11 September and
  removed the same day at Mohamed's request, and he was right: signed out,
  YouTube offers exactly one AAC stream at ~128kbps, and a Premium account is
  offered one at 256. There is nothing to choose between, so the policy is a
  single format expression that takes the best AAC the account is entitled to.
  A bitrate menu would offer numbers no source can supply. If one is ever
  demanded again, this is the argument against it.
- **Signing in to YouTube stores only youtube.com cookies.** yt-dlp's extractor
  calls `_get_cookies('https://www.youtube.com')` and nothing else, so a whole
  browser jar would put every other signed-in session on disk for no benefit.
  `google.com` is dropped with the rest, which is the difference between a file
  granting YouTube access and one granting a Google account.
- **A track this tool did not add is never removed by it.** This is the property
  the ledger exists to guarantee. An iPod may hold years of music from iTunes or
  another tool, and the cost of being wrong here is somebody's music.
- **Neutral theme, not Mango branding.** This is a personal project and must
  stay independent of the Mango tools sharing the same server — no `mango-net`,
  no shared Caddy, no shared auth. Mohamed was explicit about this.

### Technical

- **Node 22 + Postgres + Docker** for `web/`, with only two npm dependencies
  (`express`, `pg`) and no bundler for the frontend. Keeps the arm64 image fast
  to build and removes a whole class of toolchain problems.
- **Vanilla ES modules, no framework.** Every DOM node is built through
  `textContent`, which removes XSS as a category rather than relying on
  remembering to escape.
- **Python 3.11+ for `local/`.** Not Go or Rust: the two hard parts —
  `pyPodLib` (iTunesDB) and `yt-dlp` — are both Python libraries. Reimplementing
  either would be a large reverse-engineering effort for no gain.
- **Provider credentials live in the database**, editable on the Settings page,
  with environment variables taking precedence when set. For a self-hosted tool
  this is the difference between a setting being adjustable and being frozen
  behind SSH and a container restart.
- **ISRC is the primary track identity.** It is the one identifier that survives
  crossing between services, so the same recording found via two providers
  collapses to one catalogue row rather than becoming two entries on the iPod.

---

## 4. Hard-won facts

These cost real time to discover. Trust them.

### Spotify is removed and should stay removed

Spotify now refuses **all** Web API access unless the account owning the
registered app holds an active Premium subscription — every call returns
`403 Active premium subscription required for the owner of the app`, even though
the token endpoint authenticates fine. It is a policy, not a credential problem,
and it killed both metadata resolution and playlist import.

Mohamed's credentials were valid. Do not go looking for a bug. Migration
`004_drop_spotify.sql` removed the provider, the OAuth table and the id columns.
Re-adding it means a new provider module plus a migration — contained work,
since the provider layer is pluggable, but only worth doing if he gets Premium.

### pyPodLib is much larger than it looks

The first read of this library badly underestimated it. It is ~74,000 lines
across a device layer, an iTunesDB parser and writer, an artwork writer, and a
whole `sync` subsystem — including a device-aware transcoder, a content-addressed
backup manager, and a fingerprint diff engine. The high-level `api.py` is a thin
friendly face over all of it, and the low-level modules are importable.

Two consequences already taken:

- **The transcoder is used rather than reimplemented.** `pypodlib.sync.transcoder`
  knows that a clickwheel iPod refuses HE-AAC (it plays as silence), refuses
  sample rates above 48kHz and 24-bit depth, and that the limits differ by model
  — keyed to whichever device is currently open. Writing "if Opus then AAC" by
  hand would have been wrong in three ways that only show up on the device.
- **`IPod.add_tracks()` reads metadata back out of the file with mutagen.** So
  the order is download → convert → tag → hand over, and the tags written from
  the manifest are what reaches the database. Tagging after conversion, because
  ffmpeg does not carry every tag across.

`IPod.backup()` is a full content-addressed snapshot of the device, not just the
database. The first one costs the size of the music on the iPod; later ones are
nearly free. Its default location is a directory named after the project
pyPodLib was extracted from, so the destination is now passed explicitly.

### pyPodLib's actual API

The README overstates what is exported at the top level. Established by
inspection:

- Top level is only `scan_ipods()`, `connect(path)`, `library_from_path()`, and
  the `IPod` / `Library` / `Playlist` / `Track` types.
  `identify_ipod_at_path` is in `pypodlib.device`, **not** top level.
- `IPod` properties: `path`, `name`, `display_name`, `model_number`,
  `model_family`, `generation`, `serial`, `capacity`, `color`, `checksum_type`,
  `firewire_guid`. Methods: `library()`, `add_tracks()`, `save()`, `backup()`,
  `restore()`.
- **`capacity` is a string** (`"160GB"`), not bytes. Free space is not reported
  at all — use `shutil.disk_usage`.
- **An iPod Classic 7th gen (MC297) uses `ChecksumType.HASH58`, not hash72.**
  `hash72` is for iPhone-OS-era devices. A 5th gen Video (MA146) is
  `ChecksumType.NONE`. An earlier assumption of mine said otherwise and was
  wrong.
- `pypodlib.device.create_virtual_ipod(path, model_number)` simulates any of
  **204 models**. This is how the sync path gets tested without hardware, and it
  is the single most useful thing about the library.

pyPodLib is pinned to `==0.1.0` — alpha, one release, published 30 Aug 2026 —
and quarantined in `local/src/syncmypod_local/device.py`, the only module that
imports it. Everything else uses the local `IpodDevice` type, so replacing or
forking it changes one file.

### Windows has no timezone database

`zoneinfo` reads the operating system's tz database, and Windows does not have
one. pyPodLib reads the timezone the iPod itself is set to, so on Windows
**every** iTunesDB parse failed outright — `ZoneInfoNotFoundError` for
`Europe/Dublin`, which is what the attached device happened to be set to. The
`tzdata` package is now a Windows-only dependency. Nothing else on any platform
is affected, and it is invisible until you try a real device on a real Windows
machine.

### Writing the database back is lossless

Verified before touching real hardware, by copying the attached iPod's real
`iTunesDB` into a *virtual* device of the same model and round-tripping it: 184
tracks in, 184 out, every location, artist and playlist identical. The single
difference was a trailing non-breaking space being trimmed from one title —
a normalisation, not a loss.

This is the test to repeat before trusting a new pyPodLib version. It costs
nothing and it is the only thing standing between an alpha dependency and
someone's music library.

### What the real sync proved

Against an iPod Classic 6.5th gen (MB562, `HASH58`) already holding 184 tracks
put there by MediaHuman:

- All 18 library tracks and both playlists landed; the 184 existing tracks and
  their playlist were untouched; a second run did nothing.
- Multi-artist credits survive: "Aksomaniac, M.H.R, Bhumi, Circle Tone" reached
  the database intact, which is exactly what raw source metadata destroys.
- Malayalam script survives the whole pipeline into the iTunesDB.
- Every track came down as native AAC-LC at ~128kbps and needed no conversion.
- pyPodLib preserved the existing database's Mac platform flag despite the
  volume being FAT32, and verified its own write afterwards.

Two things went wrong in ways worth knowing. A YouTube result was age-restricted
and aborted the *entire* search, because `ytsearch` extracts every result and one
failure took the other five with it — `ignoreerrors` is now set on the search
only, never on a download. And one track got `403 Forbidden` after eighteen
downloads in quick succession, which succeeded on the next run; the engine
handled it correctly by failing that track alone.

### Artwork lives in two places, and only one of them is obvious

Writing album art into a file's tags does **nothing** for the iPod's screen. The
device reads a separate store — `iPod_Control/Artwork`, an `ArtworkDB` plus one
`.ithmb` of raw RGB565 frames per size — and a track whose row does not point
into it shows no cover, however well tagged the file is.

pyPodLib writes both atomically, but only if `pc_file_paths` is passed down to
the database commit, and `IPod.save()` never sets it. That one unset argument is
the entire reason art did not appear. `device.py` now builds the payload with it.

Three things about that path:

- **`pc_file_paths` can point at the copy already on the iPod.** The art is read
  out of the audio file itself, so nothing has to survive from the download.
- **Pass only the tracks this tool manages.** pyPodLib converges the device: a
  track given a source file has its art rebuilt, a track without one keeps what
  it had, and a track given a source file with no embedded cover has its art
  *cleared*. The attached iPod arrived with a 78MB artwork store from
  MediaHuman; handing pyPodLib all 202 tracks would have re-encoded all of it
  and risked wiping art whose source was never in the files.
- **The parser self-heals a stale link**, re-deriving `artwork_id_ref` from the
  `ArtworkDB`'s own song ids. So "does this track have art" is answered by the
  row *after* parsing, and a zeroed row is not a reliable way to simulate a
  device without artwork — the test helper has to delete the store as well.

Verified by decoding a frame back off the device: the 320x320 image for
"Calvin Harris, Dua Lipa - One Kiss" is the real cover, and a pre-existing
MediaHuman track's art came back byte-intact.

Needs `numpy` and `Pillow`, so the dependency is `pypodlib[artwork]` rather than
plain `pypodlib`. Not optional: without them the feature silently does nothing.

### Store Python hides the config and the backups

Python installed from the Microsoft Store runs in an app container that
redirects writes under `%LOCALAPPDATA%` into a per-package
`AppData/Local/Packages/PythonSoftwareFoundation.Python.3.13_.../LocalCache`
tree. The redirect is invisible to the writing process - it reads the file back
from the path it asked for - so `syncmypod status` reported a config path that
File Explorer insisted did not exist. The 1.2GB of iPod backups are in there too.

Not a bug, and it disappears once the app is packaged, because a PyInstaller
executable is an ordinary Win32 process. But two consequences: the pairing made
during development will **not** carry over to the packaged build, and anything
stored now is lost if that Python is reset. The CLI prints
`os.path.realpath` of the config path, which resolves the redirect.

### YouTube's 256kbps stream needs an authenticated Premium session

Verified by listing formats on a real track. Signed out, the best available is
itag 140 (AAC, 129kbps) or itag 251 (Opus, 133kbps). Itag 141, the 256kbps AAC,
simply does not appear in the format list - it is offered only to a signed-in
YouTube Music Premium account.

So Opus is never the better choice despite the higher number: an iPod cannot
play it, so taking it means a re-encode that ends up worse than the AAC it beat.

Cookie extraction has two failure modes worth knowing. Chromium locks its cookie
database while running, and since Chrome 127 seals it with App-Bound Encryption
that another process cannot unwrap on Windows at all. **Firefox is the one that
works there**, which is why it is listed first and is the default. Safari is
only offered on macOS because yt-dlp refuses it elsewhere.

### YouTube search works from the server without a key

Assumed it would need the Data API v3, because datacentre IPs are treated more
harshly than residential ones and the unofficial route tends to hit bot walls.
Measured instead, from the deployment host: the ordinary search page returns
HTTP 200 with a full `ytInitialData` payload in about half a second, and parses
to twenty results. No key, no Google Cloud project, nothing for the user to set
up.

Three things that cost a round of testing each:

- **A container restart does not pick up new code.** The source is `COPY`ed into
  the image, so `docker compose restart app` re-runs the old build. It has to be
  `up -d --build`. Two rounds of "the fix did not work" were this.
- **`ownerBadges` is not "official audio".** It marks a *verified* channel, and
  verified re-upload channels are everywhere — a test search badged
  "7clouds Latin" alongside the artist's own upload. Only a `- Topic` channel
  means the label's own audio.
- **Video titles need more than a hyphen split.** "Song | Lyric Video | Film |
  Actor | Composer" is the standard shape for South Asian music uploads, and
  "Kesariya - Lyric Video" split naively yields a track called "Lyric Video".
  Everything after the first pipe is dropped, and a right-hand side that only
  describes the upload is rejected.

### What packaging found

Freezing the application surfaced two bugs that source runs had hidden, which is
the argument for packaging before furnishing rather than after.

**A Malayalam track title crashed the sync.** Windows consoles default to a
legacy code page, and rich's Windows renderer encodes to it - so printing the
progress line for a track whose name is outside cp1252 raised
UnicodeEncodeError, which propagated out and killed the run. The library is full
of such titles, so this would have been the first thing hit. Fixed by switching
the console to UTF-8 and reconfiguring the streams with `errors="replace"`, at
import rather than in `main()`, because rich reads a stream's encoding when the
Console is constructed.

**The workspace prefix was too broad.** `purge_abandoned()` deletes anything in
the temp directory matching `syncmypod-*` that is a few hours old - which
included `syncmypod-build`, PyInstaller's working directory. A sync running
during a build would have deleted it. The prefix is now `syncmypod-run-`.

Other things worth knowing about the build:

- **Submodules are collected wholesale**, not listed. pypodlib defers nearly
  every internal import into the function that needs it, and reaches the artwork
  writer through a module-level `__getattr__`; PyInstaller's static analysis
  sees none of it. Listing them by hand would produce a build that works now and
  fails on the next pypodlib release.
- **PyInstaller hits Windows' 260-character path limit easily.** The first build
  failed copying a `.dist-info` file into a deep scratch directory. The build
  script defaults to a short temporary path for that reason.
- **A folder, not one file.** One-file mode unpacks the bundle on every launch,
  which with 148MB of ffmpeg is a ten-second startup. The zip keeps the download
  to a single file.
- **ffmpeg is the shared LGPL build on Windows**: 148MB against 255MB for the
  static one, because the two executables share DLLs instead of each embedding
  every codec. Linux stays static, where a shared build would need an rpath fix.

### Infrastructure traps

- **OCI drops inbound ports before they reach the host.** A firewalld rule is
  not enough. The security list that matters is the one attached to the
  *instance's subnet* — reach it via Compute → Instances → Oralux → Primary VNIC
  → Subnet → Security Lists. Mohamed initially edited a list that had no rule
  for port 22 or 8443 even though both worked, which proved it was not the one
  in force.
- **Ports 80 and 443 belong to the Mango dashboard's Caddy**, which must not be
  touched. That is why SyncMyPod is on 8444 and why its certificate uses the
  **DNS-01** challenge — HTTP-01 needs port 80, TLS-ALPN-01 needs 443, and
  neither is available. DNS-01 needs no inbound port at all.
- **`curl https://127.0.0.1:8444` returning 000 is not a fault.** curl sends no
  SNI to a bare IP, so Caddy cannot select a certificate. Test with
  `curl --resolve syncmypod.duckdns.org:8444:127.0.0.1 https://syncmypod.duckdns.org:8444/...`.
- **`/root/syncmypod` on the server is an rsync target, not a clone.** The web
  files sit at its root. Deploy by syncing `web/*` there — do not `git pull` into
  it expecting the repository layout.
- The GitHub PAT stored on the server is fine-grained and **cannot create
  repositories**, and was not scoped to this one. Pushing works from Mohamed's
  Windows machine, where Git Credential Manager now holds a credential.

### Resolution bugs already found and fixed

Worth knowing so they are not reintroduced:

- `scoreCandidate` stripped decorations from the query title but not the
  candidate's, so `Kesariya (From "Brahmastra")` scored 0.5 against the query
  `Kesariya` while an unrelated single simply titled `Kesariya` scored 1.0 — the
  generic single won. Both sides are stripped now.
- The scorer discarded the provider's own result ordering, which is by
  popularity. A song and its remix tie on title and artist, so the winner came
  down to iteration order. A capped 0.02 position bonus decides ties.
- Deezer's `album:` query qualifier turns a good match into zero results,
  because album titles diverge between services — searching Kesariya with
  `album:"Brahmastra"` returns nothing, since Deezer files that album as
  "Kesariya". The album is a scoring signal only, never a filter.
- MusicBrainz models every live performance as its own recording, so a
  well-known song returns the studio take buried among identically-titled
  bootlegs. Release quality is scored and subtracted.

---

## 5. What is next

### Immediately: furnishing

Mohamed's word for visual polish, and the last thing on the list by his own
sequencing - polish before the features settle means polishing twice.
`web/public/css/theme.css` is all tokens and the local app's GUI carries a copy,
so re-theming is two files that must be kept in step.

### Packaging, as it now stands

- `python scripts/build.py` fetches ffmpeg, runs PyInstaller and writes
  `local/dist/SyncMyPod-<version>-windows-x64.zip` — 174MB, 395MB unpacked.
- `.github/workflows/release.yml` does the same on a `local-v*` tag and attaches
  the zip to a draft GitHub release. Not committed to the repository, because a
  few hundred megabytes per version would live in the history forever.
- **Windows only.** PyInstaller does not cross-compile — it bundles the
  interpreter and native libraries of the machine it runs on. Linux means adding
  a runner; macOS means that *and* resolving the ffmpeg licensing question,
  since every readily available static macOS build is GPL and this project is
  MIT. `fetch_ffmpeg.py` refuses macOS rather than quietly bundling one.
- Expect Windows Defender false positives on an unsigned build. Code signing is
  the real fix and costs money.

### Then

1. **Pairing from the GUI.** CLI-only, which is defensible for a once-per-computer
   job but is the one thing that still forces a terminal.
2. **A local-files source.** The highest-quality option available and the only
   one with no downside: point the app at a folder of music already owned, match
   manifest tracks against it, and skip downloading entirely. The iPod Classic
   plays Apple Lossless, so a CD rip can go on untouched. Discussed with Mohamed
   on 11 September and deferred; the engine already has every piece it needs.

### Open questions not yet decided

- Whether to strip `(From "...")` suffixes from titles before writing tags. They
  currently reach the iPod verbatim.
- Deezer's contributor order puts the composer first, so Kesariya reads
  "Pritam, Arijit Singh, ..." rather than leading with the singer. Faithful to
  the source; may not be what he wants on the device.
- HSTS is still `max-age=0`. Ready to enable, deliberately not done — it is a
  one-year browser commitment with no quick undo.
- The GUI polls for progress every 600ms. Server-sent events would be tidier but
  polling a localhost server costs nothing and cannot get stuck half-open.
- Removal is offered but never automatic, and the GUI shows exactly what would
  go before doing it. Worth checking that is still the right default once the
  library is real rather than 18 test tracks.

## 6. Working conventions

- **Commits** explain *why*, not what. The diff shows what changed; the message
  should say what problem it solves and what was traded away.
- **Comments** explain reasoning, not mechanics. Prefer one paragraph on why a
  thing is the way it is over a line-by-line narration.
- **Verify, don't assume.** Several documented "facts" turned out wrong when
  checked against the real library or a real request. Run the thing.
- **Report failures plainly.** If a test fails, say so with the output.
- **No secrets in the repository.** `.env` and `config.json` are gitignored.
- **Tests.** The Windows machine does have Python now (3.13), so the quickest
  loop is a virtualenv rather than a container. It is kept outside the project
  directory because that directory is synced to OneDrive and a venv is thousands
  of files:
  ```bash
  python -m venv "$USERPROFILE/.venvs/syncmypod"
  "$USERPROFILE/.venvs/syncmypod/Scripts/python" -m pip install -e "local[dev]"
  cd local && "$USERPROFILE/.venvs/syncmypod/Scripts/python" -m pytest
  ```
  The container still works and is what CI uses:
  ```bash
  cd local
  docker build -f Dockerfile.dev -t syncmypod-local-dev .
  docker run --rm -v "$PWD:/app" syncmypod-local-dev pytest
  ```
  The full suite takes about three minutes; most of it is writing and signing
  simulated iTunesDB files, which is the part worth not mocking.

### Deploying a change to the web tool

```bash
# From the repository root — note web/* , not the repo root
tar -czf - -C web --exclude=node_modules --exclude=.env . \
  | ssh root@100.96.249.123 'tar -xzf - -C /root/syncmypod'
ssh root@100.96.249.123 'cd /root/syncmypod && docker compose --profile public up -d --build'
```

Migrations apply automatically at startup.

---

## 7. Loose ends

- A test device named **"Dev container"** is paired against the live server from
  CLI testing, and **"Mo Desktop"** is the Windows machine used for the hardware
  testing. Revoke either from the web interface when convenient.
- **The attached iPod is not Mohamed's.** It is "Nihal's ipod", and the 18
  library tracks were written onto it alongside 184 that were already there. It
  has a full backup in `%LOCALAPPDATA%\SyncMyPod\backups` taken before the first
  write, so putting it back exactly as it was is `IPod.restore(snapshot_id)`.
- **`local/src/syncmypod_local/_bin` holds ~254MB of ffmpeg binaries** fetched
  for testing the bundled path. Gitignored, but inside a OneDrive-synced folder,
  so it will sync. Delete it if that is a nuisance; `fetch_ffmpeg.py` gets it
  back.
- **`Desktop/Claude/syncmypod-local`** on Mohamed's machine is the now-redundant
  original local-app repository. Its commit is preserved in the monorepo under
  `local/`. Safe to delete.
- CI workflows have been pushed but have not yet run — the first push touching
  `web/` or `local/` will trigger them. `local.yml` should pass; `web.yml`
  compiles Caddy from source and will be slow.
- The live instance still holds 18 test tracks from resolver verification.
  Real data, correctly resolved, but not a curated library — and now all 18 are
  on the iPod, so the next real test is adding something to the library and
  watching it appear.
- A pairing code was minted directly in the `pairing_codes` table over SSH
  rather than generated in the web interface, because the interface needs a
  browser session. Equivalent, but worth knowing that is possible:
  ```sql
  INSERT INTO pairing_codes (code, user_id, expires_at)
  SELECT 'ABCD1234', id, now() + interval '20 minutes' FROM users LIMIT 1;
  ```
