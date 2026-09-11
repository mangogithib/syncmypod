# Handover

Working context for anyone — human or AI — picking this project up. It covers
what exists, what was decided and why, the traps already discovered, and what
comes next.

For what the tool *is*, read [README.md](README.md). For how it works
internally, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This file is the
project's state and its reasoning.

**Last updated:** 11 September 2026

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
| **Local app: the sync engine** | **Not started — this is next** |
| Local app: GUI | Not started (deliberately after the engine) |
| Packaging to a single executable | Not started |

Roughly 14,700 lines across 45 JavaScript files, 6 Python modules, 4 SQL
migrations. 25 Python tests, all passing.

### Live instance

| | |
|---|---|
| Public URL | `https://syncmypod.duckdns.org:8444` |
| SSH | `ssh root@100.96.249.123` |
| Public IP | `145.241.202.47` |
| Deploy directory | `/root/syncmypod` |
| Containers | `syncmypod-app-1`, `syncmypod-db-1`, `syncmypod-caddy-1` |
| Certificate | Let's Encrypt, expires 10 Dec 2026, auto-renews |
| Contents | 1 user, 18 tracks, 43 artists, 2 playlists, 2 paired devices |

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
  a CLI is testable.
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

### pyPodLib's actual API

The README overstates what is exported. Established by inspection:

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

### Immediately: the sync engine

This is the remaining substantial piece. It lives in `local/` and turns the
existing pairing and device detection into an actual sync.

A run, in order:

1. `hello` — confirm the token and that the manifest version is understood
2. Detect the iPod, report it to the server
3. **Back up the iPod database** (`IPod.backup()`) before touching anything
4. Fetch the manifest and the server's view of device state
5. Diff against what is actually on the device
6. Open a sync run
7. For each missing track: download, **re-tag from the manifest**, transcode if
   the iPod cannot play the format, write it, report the result
8. Write playlists in manifest order
9. Prompt before removing anything no longer in the library
10. Finish the run, then **delete every downloaded file**

Modules to add: `sync.py` (orchestration), `downloader.py` (yt-dlp),
`tagging.py` (mutagen), `transcode.py` (ffmpeg), `cleanup.py`.

Points that need care:

- **Re-tagging is the whole point.** Whatever metadata a download source
  embedded is discarded and replaced with the manifest's. Never trust the
  source's own title.
- **An iPod cannot play Opus**, which is what YouTube usually returns.
  Transcode to AAC; pass through untouched when the source is already M4A or
  MP3, since re-encoding a lossy source twice is pure loss.
- **Build against a virtual iPod first.** `device.create_virtual(path, "MC297")`
  gives a real Classic 7g including its HASH58 requirement.
- **Report results incrementally**, not just at the end, so an interrupted sync
  does not re-download what already landed.
- Mohamed has the iPod and can test on real hardware. Give him a validation
  checklist before anything writes to it.

### After that

1. **Packaging** — PyInstaller single executable, per platform. Expect Windows
   antivirus false positives; code signing is the real fix but costs money.
2. **GUI** — one window over the CLI engine: device status, Sync now, progress.
3. **Artwork** — pyPodLib has an `artwork` extra; the manifest already carries
   `artworkUrl`.
4. **Furnishing** — Mohamed said "we will do furnishing on this later", meaning
   visual polish and theming. `web/public/css/theme.css` is all tokens, so
   re-theming is one file.

### Open questions not yet decided

- Whether to strip `(From "...")` suffixes from titles before writing tags.
  They currently reach the iPod verbatim. It is editable per track, but a global
  convention may be wanted.
- Deezer's contributor order puts the composer first, so Kesariya reads
  "Pritam, Arijit Singh, …" rather than leading with the singer. Faithful to the
  source; may not be what he wants on the device.
- HSTS is still `max-age=0`. Ready to enable, deliberately not done — it is a
  one-year browser commitment with no quick undo.

---

## 6. Working conventions

- **Commits** explain *why*, not what. The diff shows what changed; the message
  should say what problem it solves and what was traded away.
- **Comments** explain reasoning, not mechanics. Prefer one paragraph on why a
  thing is the way it is over a line-by-line narration.
- **Verify, don't assume.** Several documented "facts" turned out wrong when
  checked against the real library or a real request. Run the thing.
- **Report failures plainly.** If a test fails, say so with the output.
- **No secrets in the repository.** `.env` and `config.json` are gitignored.
- **Tests run in Docker**, because the Windows machine has no Python and the
  server has only 3.9:
  ```bash
  cd local
  docker build -f Dockerfile.dev -t syncmypod-local-dev .
  docker run --rm -v "$PWD:/app" syncmypod-local-dev pytest
  ```

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
  CLI testing. Harmless; revoke it from the web interface when convenient.
- **`Desktop/Claude/syncmypod-local`** on Mohamed's machine is the now-redundant
  original local-app repository. Its commit is preserved in the monorepo under
  `local/`. Safe to delete.
- CI workflows have been pushed but have not yet run — the first push touching
  `web/` or `local/` will trigger them. `local.yml` should pass; `web.yml`
  compiles Caddy from source and will be slow.
- The live instance still holds 18 test tracks from resolver verification.
  Real data, correctly resolved, but not a curated library.
