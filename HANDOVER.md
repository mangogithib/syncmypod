# Handover

Working context for anyone — human or AI — picking this project up. It covers
what exists, what was decided and why, the traps already discovered, and what
comes next.

For what the tool *is*, read [README.md](README.md). For how it works
internally, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This file is the
project's state and its reasoning.

**Picking this up cold? Read section 9 first** - it is a page, and it covers the
state of play, what was built most recently, and the eight things that were
tried and got wrong before they were got right. Then come back to section 3,
which is the one rule the whole design rests on.

**Last updated:** 13 September 2026, end of day.

---

## 1. Where things stand

| Area | State |
|---|---|
| Web library manager | Working, deployed, publicly reachable over HTTPS |
| Metadata resolution | Working — Deezer → iTunes → MusicBrainz → YouTube Music. **No API keys anywhere** |
| Search | Combined by default; YouTube Music as a named fallback |
| Artist and album pages | Working — browse a discography before adding anything |
| Import: a playlist link | **Spotify, Apple Music, YouTube, YouTube Music, Deezer** in one box |
| Import: a pasted list | Working — dash, tab and CSV shapes |
| Sources (followed playlists) | Same five services, re-read when the page is opened |
| Re-matching songs with no artist | Working — a re-run of the resolver, merged into existing rows |
| Splitting combined artist credits | Working — checked against Deezer, so real bands survive |
| Metadata autocomplete | Working — library names first, completing the name under the caret |
| Followed artists | Working — future releases, optionally the back catalogue |
| Device pairing + sync API | Working, verified end to end. Failed tracks now show in the web library |
| Local app: the sync engine | Working, verified on real hardware — a blank restored iPod included. **Four downloads at a time** |
| Playlists on the device | Working — **written to MHSD 3, the dataset the iPod reads.** Reconciled every sync |
| Album art on the device | Working — verified by decoding it back off the iPod |
| Source stream taken | **Opus since 15 September**, converted to 256kbps AAC. YouTube's free AAC is cut at 15.8kHz; the Opus runs to 20kHz. See section 5 |
| Audio quality on the device | **Fixed 14 September** — every AAC file was recorded as an MP3 in the iTunesDB, which is what made the iPod screech. See section 5 |
| Backup before a sync | On by default, and **can now be turned off** — a toggle in the app, `--no-backup` on the CLI |
| YouTube Premium sign-in (local) | Reads a browser where it can, else **opens one of its own** and takes the session from it |
| Local app: GUI | Working — nothing needs a terminal. **A window of its own since 15 September**, not a browser tab |
| Knowing what cannot be synced | **`check-matches`** searches without downloading and reports it per track, so it no longer takes a sync to find out |
| Selecting several songs at once | Working — click/shift/ctrl on a pointer, long press then drag on a phone. Bulk add to playlist, remove from playlist, remove from library |
| Downloadable build | **Published — 0.2.2**, built and attached by CI from the `local-v0.2.2` tag. `SyncMyPod.exe` is windowed; `syncmypod.exe` is the CLI |
| Phone layout | Working — measured at 375px, list rows included |
| CI | Green. Parses every file, checks for undefined references, checks the api client, runs migrations |
| Connected YouTube account | **Removed.** Needed a per-instance Google client *and* a Test users entry |
| **A web test suite** | **Still none. The biggest gap — see section 6** |

About 23,900 lines: 55 JavaScript files, 17 Python modules, 8 SQL migrations.
**285 Python tests, all passing. Zero JavaScript tests.**

Swept for dead code on 13 September across all three languages - unused Python
defs, JS exports nothing imports, CSS classes no markup carries. Three things
were removed and the rest of the list was false positives worth keeping; the
reasoning is in the commit for `d7a5dce`.

### Live instance

| | |
|---|---|
| Public URL | `https://syncmypod.duckdns.org:8444` |
| SSH | `ssh root@100.96.249.123` |
| Public IP | `145.241.202.47` |
| Deploy directory | `/root/syncmypod` (an rsync target, **not** a clone) |
| Containers | `syncmypod-app-1`, `syncmypod-db-1`, `syncmypod-caddy-1` |
| Certificate | Let's Encrypt, expires 10 Dec 2026, auto-renews |

**Library contents, end of 13 September** — this is Mohamed's own music now,
not test data. Do not clear it. These are the app's own numbers, from the same
query the sidebar uses (`libraryStats`); an earlier version of this table gave
579 artists and 407 albums, which were whole-catalogue counts rather than his
library.

| | |
|---|---|
| Songs | 447 |
| Artists / albums | 499 / 333 |
| Playlists | 1 ("Liked", 94 tracks) |
| Songs with no artist | 15 — they sync, with the fields blank |
| Tracks the sync could not fetch | 7 — shown on the Overview and filterable |
| Combined artist rows | 0 |
| Paired devices | 1 active (MANR-LT001); four older ones revoked |
| Followed artists | 3 |
| Followed sources | 0 |

Where the songs came from: 290 from YouTube playlist imports, 72 from the
follow-artist backfill, 20 from search, 8 from browsing, 5 from lists and
Deezer.

**A note on the playlist count.** Only one playlist exists although several
playlists were imported, because most of those imports ran with "Recreate it as
a playlist here" unchecked - the import history shows `target_playlist_id` null
for all but one. Several `DELETE FROM playlists` statements were also run during
testing to clear test data, and it is possible one removed more than intended.
If a playlist is missing that should not be, that is the likeliest cause; the
tracks themselves are all still in the library.

### The download

<https://github.com/mangogithib/syncmypod/releases/latest>

`SyncMyPod-0.1.6-windows-x64.zip`, 175MB. Unpack anywhere and run
`syncmypod.exe`. Everything — pairing included — happens in the window that
opens.

**Cut a release by pushing a tag, and nothing else.**

```bash
git tag -a local-v0.1.6 -m "..." && git push origin local-v0.1.6
```

`release.yml` then runs the full suite on a Windows runner, builds with
PyInstaller and attaches the zip to a published release, so the download is the
build the tests passed against. 0.1.6 was cut this way and it worked cleanly.

The trap is doing both: **creating a release through the API also creates the
tag**, which fires the same workflow, which builds its own copy and replaces a
hand-uploaded asset mid-upload. 0.1.0 and 0.1.1 were published by hand with that
run cancelled. Pick one route; the tag is the better one.

**Credentials are deliberately not in this file.** It is in a git repository,
and repositories get cloned and shared. The account is `mo`; reset the password
without needing the old one:

```bash
ssh root@100.96.249.123 'cd /root/syncmypod && docker compose exec app npm run create-user -- mo'
```

Secrets live in `/root/syncmypod/.env` (chmod 600) and the `app_settings` table.
Nothing sensitive is in the repository.

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

## 3. The metadata rule

This is the single most important idea in the project, and every source has to
obey it. It is worth stating on its own because it is the thing most likely to
be quietly broken by a well-meaning change.

**A download source's own metadata is never trusted.** Whatever a track claims
to be, it is re-resolved against a real catalogue before anything is written to
the iPod. A video title is not metadata. A channel name is not an artist.

That produces three outcomes, and only three:

| Outcome | Stored as | Syncs to the iPod? |
|---|---|---|
| A catalogue confirmed it | `resolved` — its artist, album, artwork, ISRC | Yes |
| Nobody confirmed it | `unresolved` — **title only**, artist blank, album null | No |
| A human filled it in | `manual` | Yes |

The second row is the one that matters. The tempting alternative is to write the
guess into the artist field, which produces a library that looks populated and
is wrong — and wrong in a way nobody notices until it is on the device. A blank
field a user can see beats a plausible wrong one they have to catch.

In code this is `discardUnverifiedMetadata` in
[`web/server/services/resolver.js`](web/server/services/resolver.js), and the
`skipResolve` branch in `routes/library.js` for single tracks added from search.
The sync manifest gates on `metadata_state IN ('resolved','manual')`, so an
unresolved track physically cannot reach an iPod.

Measured on a real 50-track YouTube playlist: 43 resolved with full credits and
ISRCs, 7 left with a title only — all seven genuinely too new for the
catalogues.

---

## 4. Decisions already made — please don't re-litigate these

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
- **The GUI is a page served to the local browser**, not a desktop toolkit.
  Mohamed chose this over Tkinter and PySide6. It adds no dependency, keeps the
  packaged executable small, and can use the web tool's own design tokens so the
  two halves look like one product. The cost is that it is a browser tab rather
  than a window, and that `theme.css` now exists in two places.
- **Nothing needs a terminal.** Pairing was CLI-only until 11 September;
  Mohamed's words were "I dont want terminal, paring should be simple and sone
  on GUI iteself. No terminal should be used." The executable now launches the
  GUI when double-clicked and still takes commands when given them.
- **The record of what was synced lives on the iPod**, in
  `iPod_Control/Device/SyncMyPod.json`, not in the computer's config directory.
  An iPod moved between two computers then continues one history rather than
  starting a second. Keyed by server and user, so two accounts can share a
  device.
- **AAC in an `.m4a` on the device - but the stream downloaded is Opus.**
  Superseded on 15 September; the previous version of this entry said the
  opposite and the reasoning is worth keeping so it is not reversed again.

  What was decided on 13 September: a 5.5th gen plays MP3, AAC, Apple Lossless,
  AIFF and WAV; YouTube serves AAC and Opus; the iPod cannot play Opus - so take
  the AAC and pass it through **untouched**, because re-encoding a lossy source
  is pure loss. The conclusion drawn was that "the format is not the lever".

  What was missed: nobody had measured the two streams. YouTube's free AAC is
  brickwalled at **15.8kHz** and its Opus runs to **20kHz**, so the re-encode
  that entry was avoiding buys back more than 4kHz of treble. Section 5 has the
  numbers. The download now prefers Opus and converts it to 256kbps AAC, and
  takes AAC directly only when it is Premium's 256kbps stream.

  The rest of that entry stands. MP3 would be a second lossy pass for a larger
  file, and ALAC or WAV would be a lossless container around lossy audio - 6x
  the size on the device to avoid a second generation that measures at -32dB.
  Both are still strictly worse. And the **source** is still the real lever:
  Premium's 256kbps AAC needs no conversion at all, and a file the user already
  owns is lossless - which remains the argument for the local-files source in
  section 6.
- **Two ideas raised on 13 September and turned down.** Writing only the primary
  artist to the device, so the iPod's Artists menu reads "Arijit Singh" rather
  than the full credit - Mohamed wants the full credit. And backfilling the
  source URLs of the 286 older YouTube imports so they skip the search - not
  wanted, and the relaxed 40-second pass covers the failure it was aimed at.
  Both are recorded here so they are not proposed a second time.
- **No audio quality setting, deliberately.** One was built on 11 September and
  removed the same day at Mohamed's request, and he was right: signed out,
  YouTube offers exactly one AAC stream at ~128kbps, and a Premium account is
  offered one at 256. There is nothing to choose between, so the policy is a
  single format expression that takes the best AAC the account is entitled to.
  A bitrate menu would offer numbers no source can supply.
- **The backup before a sync can be turned off, and is on by default.** Asked
  for on 14 September. The default must stay on - rewriting the iTunesDB is the
  one operation here that can leave a device unusable, and pypodlib is alpha -
  but a snapshot is a full copy of the music on the iPod, so on a full 160GB
  Classic the first one is slow and the disk it lands on may not have room. That
  is a real reason to turn it off and it is the user's call.

  It is a setting rather than a per-run flag in the app: it is saved the moment
  the box is unticked, so closing the window does not quietly turn backups back
  on. The CLI's `--no-backup` applies to that run only and does not change the
  stored preference. A skipped backup is said out loud in the log, the terminal
  and the page - "I never turned that off" is exactly what somebody says after
  losing a device.
- **The local app is a window, not a browser tab, and that is not a reversal of
  the GUI decision.** Asked for on 15 September. The 11 September entry above
  chose a served page over Tkinter and PySide6, and every reason it gave still
  holds - so the page is unchanged and only how it is shown is different.

  **It is a Chromium browser in `--app` mode, in a windowed executable, and two
  earlier attempts failed first.** pywebview (0.1.8) could not open a window in
  the packaged build at all; app mode (0.1.9) opened one and then killed the
  server under it. 0.2.0 is the one that works. See `gui/window.py` and the two
  bullet points below.

  **pywebview was tried first and did not work.** 0.1.8 shipped with pywebview and failed on the first run of
  the packaged build: `Failed to resolve Python.Runtime.Loader.Initialize from
  .../_internal/pythonnet/runtime/Python.Runtime.dll`. Its Windows backend
  hosts WebView2 through pythonnet, which needs a .NET runtime resolved from
  inside a frozen PyInstaller bundle - and it cost several megabytes of .NET
  assemblies to not work. `msedge --app=<url>` needs nothing bundled, nothing
  installed, and draws a window with no tabs, no address bar, its own taskbar
  entry and the app icon. pythonnet and webview are now in the spec's
  `excludes`.

  **The dedicated `--user-data-dir` is load-bearing.** Against the user's normal
  profile, `--app=` is handed to the browser they already have open and returns
  immediately - so there is no process to wait on, the server is shut down while
  the window is still up, and closing the window does not end the application.

  It always falls back, and 0.1.8 got that wrong too: it shut the server down
  when the window failed, then handed the dead address to a browser, so the user
  saw a connection refused page beside a console saying the application was
  running. `window.run` now leaves the server alone on every failure path, and
  `test_gui.py` asserts exactly that. `--browser` forces a normal tab;
  `--no-browser` prints the address and opens nothing.

  **The window's lifetime is measured by the page, not by the process, and that
  is what 0.1.9 got wrong.** A Chromium launcher hands the request to a session
  process and exits, so `process.wait()` returns while the window is still on
  screen - and the server was shut down at that point, giving a window with no
  tabs showing "can't reach this page". Whether the launcher behaves that way
  depends on whether that profile already had a browser running, which is
  exactly why it worked once in testing and not on the machine it shipped to.

  So the page pings `/api/ping` every five seconds and the launcher waits for
  those to stop. The process is still watched, but only as a second opinion: the
  server stops when the process has gone **and** the page has fallen silent.
  There is a test for the handed-off-and-exited case specifically.

  **Two executables, because `console` is decided per executable.**
  `SyncMyPod.exe` is windowed and is what people double-click - 0.1.9 opened a
  proper window and left a terminal behind it saying "Press Enter to close",
  which is not what an application does. `syncmypod-cli.exe` sits beside it for
  `sync`, `check-matches` and the rest, which print and so need somewhere to
  print to. One PyInstaller analysis, two `EXE()` blocks.

  **The two names must differ by more than case, and 0.2.0 shipped broken
  because they did not.** They were `SyncMyPod` and `syncmypod`, which is one
  filename on Windows: PyInstaller built both, reported both as successful,
  exited zero, and one overwrote the other in the output directory - so the
  release contained only the console build. Nothing caught it except unzipping
  the published asset. `build.py` now checks for both by name and fails the
  build if either is missing, which is the check that should have existed the
  first time an executable was renamed.
- **Matching stays in the local app, and server-side matching was turned down
  with a reason.** Proposed on 15 September: have the web tool find each
  track's audio in the background so the user learns what cannot be synced
  without plugging in an iPod. The goal is right and is now met by
  `syncmypod check-matches`, which runs the real search with no download and
  reports per track.

  Doing the searching on the server does not work, and the evidence is already
  in section 5: a home connection was blocked after one large sync, every
  search returning the bot check. A datacentre address is what that check is
  aimed at, it would be the same address for every search forever, and the only
  known remedy is a signed-in session - which means a Google credential on a
  public box. It would also mean porting 200 lines of tuned scoring to
  JavaScript or putting Python on the Node server, and yt-dlp breaking would
  become downtime rather than an app update.

  If it is ever revisited, use the **YouTube Data API** for search rather than
  scraping: quota'"'"'d rather than bot-checked, an API key rather than the OAuth
  client that killed the connected account, and roughly 100 searches a day on
  the default quota - too slow for a 450-track backlog, fine for a trickle.
- **There is exactly one YouTube sign-in, and it is in the local app.** The
  browser's own cookies, on the user's machine, used to fetch the 256kbps stream
  a Premium account is entitled to. It never leaves that machine, and the server
  holds no YouTube credential of any kind.

  A second one briefly existed in the web app - a read-only OAuth grant for
  listing playlists - and was removed. Section 5 has why.
- **Signing in to YouTube locally stores only youtube.com cookies.** yt-dlp's
  extractor calls `_get_cookies('https://www.youtube.com')` and nothing else, so
  a whole browser jar would put every other signed-in session on disk for no
  benefit. `google.com` is dropped with the rest, which is the difference
  between a file granting YouTube access and one granting a Google account.
- **A track this tool did not add is never removed by it.** This is the property
  the ledger exists to guarantee. An iPod may hold years of music from iTunes or
  another tool, and the cost of being wrong here is somebody's music.
- **Neutral theme, not Mango branding.** This is a personal project and must
  stay independent of the Mango tools sharing the same server — no `mango-net`,
  no shared Caddy, no shared auth. Mohamed was explicit about this.
- **Base version first, then furnish.** Mohamed's own sequencing, stated on
  11 September: get something whole working, then improve it. Polish before the
  features settle means polishing twice.

### Technical

- **Node 22 + Postgres + Docker** for `web/`, with only two npm dependencies
  (`express`, `pg`) and no bundler for the frontend. Keeps the arm64 image fast
  to build and removes a whole class of toolchain problems.
- **Vanilla ES modules, no framework.** Every DOM node is built through
  `textContent`, which removes XSS as a category rather than relying on
  remembering to escape.
- **Python 3.11+ for `local/`.** Not Go or Rust: the two hard parts —
  `pyPodLib` (iTunesDB) and `yt-dlp` — are both Python libraries. The 3.11 floor
  is real: pyPodLib requires it, and people run whatever Python they have.
- **Provider credentials live in the database**, editable on the Settings page,
  with environment variables taking precedence when set. For a self-hosted tool
  this is the difference between a setting being adjustable and being frozen
  behind SSH and a container restart.
- **ISRC is the primary track identity.** It is the one identifier that survives
  crossing between services, so the same recording found via two providers
  collapses to one catalogue row rather than becoming two entries on the iPod.
- **Background jobs, not long requests.** Every bulk import returns
  `202 {jobId}` immediately and works through an `import_jobs` row while the
  client polls. A 300-track list means 300 resolutions; a request that takes
  four minutes gets killed by a proxy long before it finishes. State is in
  Postgres, so progress survives a container restart.

---

## 5. Hard-won facts

These cost real time to discover. Trust them.

### Spotify is removed and should stay removed

Spotify now refuses **all** Web API access unless the account owning the
registered app holds an active Premium subscription — every call returns
`403 Active premium subscription required for the owner of the app`, even though
the token endpoint authenticates fine. It is a policy, not a credential problem,
and it killed both metadata resolution and playlist import.

Mohamed's credentials were valid. Do not go looking for a bug. Migration
`004_drop_spotify.sql` removed the provider, the OAuth table and the id columns.

### YouTube's AAC stream is brickwalled at 15.8kHz; its Opus is not

Measured on 15 September, because "is the quality the best it can be" had never
been answered with a number. It is the reason the download policy changed.

Signed out, YouTube offers five audio-only streams. The two that matter:

| itag | codec | bitrate | measured cutoff |
|---|---|---|---|
| 140 | AAC-LC | 129kbps | **15.8kHz** |
| 251 | Opus | 145kbps | **20.1kHz** |

Above 15.8kHz the AAC stream is not quiet, it is **empty** - the 16-17kHz band
sits at -105dB where Opus has it at -50dB. Measured on three unrelated tracks
(Daft Punk, A.R. Rahman, Billie Eilish) the figure was 15.8kHz every time, so it
is a property of YouTube's encoding ladder rather than of any one upload.

**Converting the Opus to AAC keeps it.** Against the Opus it was made from:

| target | cutoff | error to source |
|---|---|---|
| 192kbps (pypodlib's default) | 19.5kHz | -28.7dB |
| **256kbps (`lossy_quality="high"`)** | **20.1kHz** | **-32.1dB** |
| 320kbps | 20.1kHz | -37.7dB |

256 is the knee: it reproduces the source's spectrum to within 0.2dB in every
band, and 320 buys 4dB more accuracy for a quarter more space on the device. The
output is AAC-LC at 48kHz stereo, inside every limit a clickwheel iPod has, and
it decodes without a warning.

So the second lossy generation costs far less than the 4kHz it recovers, and
`downloader.py` now asks for Opus. Premium's 256kbps AAC (itag 141) is still
taken directly where it is offered - full bandwidth and no re-encode at all -
which is the one case that beats both. **Untested on a real Premium account**;
the ordering assumes a 256kbps AAC is not band-limited the way the 128 is.

**Two things this depends on that are not obvious.**

- yt-dlp saves Opus as `.webm`, and pypodlib classifies `.webm` as **video**. Left
  alone it would set about making an iPod video file out of an audio download. A
  `FFmpegExtractAudio` postprocessor with `preferredcodec="best"` puts it in
  `.opus` instead - a stream copy, verified bit-identical (-190dB), and one that
  yt-dlp skips entirely when the file is already AAC in an `.m4a`.
- **Opus needs ffmpeg and AAC does not.** The remux and the conversion both
  require it, so without ffmpeg the download falls back to the old AAC-first
  expression. One track short is a bad sync; every track short is a broken one.

**The encoder is ffmpeg's native `aac`.** The bundled builds are BtbN's LGPL
ones, which cannot carry libfdk_aac, and there is no macOS `aac_at` on Windows
or Linux. At 256kbps this does not matter much - the measurements above are all
native `aac` - but it is why the bitrate is set generously rather than trusting
the encoder at 192.

**What this does not fix.** Tracks already on the device were downloaded as
15.8kHz AAC and the ledger will not fetch them again. They keep the quality they
were synced at unless they are removed and re-added. There is no bulk refetch
mode and adding one was not asked for - see section 6.

### Every AAC file was recorded in the iTunesDB as an MP3

**The screeching.** Tracks on the real Classic played with bursts of harsh noise
at random points. The files were fine: all 453 probed as AAC-LC 44.1kHz stereo,
and every one decoded through ffmpeg with no error at all. The fault was in the
database.

Each row of the iTunesDB carries a four-character code naming the track's format
and a matching `mp3_flag`. It is how the iPod picks a decoder. Read straight off
the device, all 453 rows said `MP3 ` with `mp3_flag = 1`, on 453 `.m4a` files.
The firmware was parsing an MP4 container as an MPEG frame stream, and where it
resynced on something that was not a frame header the output was noise.

It is a case mismatch between two functions inside pypodlib 0.1.0:

- `api.add_tracks` stages the value through `ipod_filetype_for_extension`, which
  returns `"m4a"` — lower case.
- `_track_conversion.track_dict_to_info` resolves it by testing that string
  against a list of capitalised needles with a plain `in`. `"M4A" in "m4a"` is
  False, every needle misses, and it falls through to its `"mp3"` default.

MP3 was the only format that ever came out right, and only because it was the
default being fallen back to.

**How it is fixed**, both in `device.py`:

- `_install_filetype_fix` corrects the value at source, so new rows are staged
  with a spelling the writer recognises. It checks the round-trip first and does
  nothing if it already works, so it retires itself when pypodlib fixes this.
- `repair_filetypes` re-derives the format from each row's own filename before
  a save. Rows already on a device read back as `"MP3"` and are re-serialised on
  every save, so they stay wrong until something rewrites them — this is what
  heals a library written by an older version. It runs before `add_tracks`
  (which commits internally) rather than after, so the repair rides along in a
  write that was happening anyway instead of costing a second full iTunesDB
  rewrite per batch.

**If you touch this, keep the test.** `TestRecordedTrackFormat` in
`test_device.py` reads the four-character codes out of the on-disk database
rather than asking this application what it thinks it wrote, and
`test_every_container_maps_to_the_code_it_should` asserts the one thing the fix
depends on and does not own: pypodlib's needle spellings. Change those upstream
and the map silently goes back to writing `MP3 ` for everything.

**What this was not.** Ruled out with evidence before the database was suspected,
so nobody spends the time twice: the AAC bitstreams are clean (ffmpeg decodes
every file without a single warning); the codec, sample rate and channel count
are within the iPod's limits on every file; `size` in the database matches the
file on disk for all 453; and the `mp4a` sample-rate field is a correct 44100.
The files are fine. They always were.

**Still open, and unrelated to the noise.** `sample_count`, `pregap`, `postgap`
and `gapless_audio_payload_size` are all zero on every row, so nothing trims the
AAC encoder delay and there is a small gap between tracks. pypodlib does not
compute them. Worth doing one day; it is a gap, not a glitch.

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
  the order is download → convert → tag → hand over. Tagging after conversion,
  because ffmpeg does not carry every tag across.

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
- **`capacity` is a string** (`"160GB"`), not bytes. Free space is not reported
  at all — use `shutil.disk_usage`.
- **An iPod Classic 7th gen (MC297) uses `ChecksumType.HASH58`, not hash72.**
  `hash72` is for iPhone-OS-era devices. A 5th gen Video (MA146) is
  `ChecksumType.NONE`.
- `pypodlib.device.create_virtual_ipod(path, model_number)` simulates any of
  **204 models**. This is how the sync path gets tested without hardware, and it
  is the single most useful thing about the library.

Pinned to `==0.1.0` — alpha, one release, published 30 Aug 2026 — and
quarantined in `local/src/syncmypod_local/device.py`, the only module that
imports it. Everything else uses the local `IpodDevice` type, so replacing or
forking it changes one file.

### A restored iPod has no database, and a simulated one always does

An iPod restored in iTunes and not synced since has `iPod_Control/iTunes` with
a pre-allocated 75MB `iTunesControl` in it and **no `iTunesDB`**. Reading it
raises `FileNotFoundError: iTunesDB was not found`, which is where the sync
stopped dead for anyone setting a device up. `ensure_database()` in `device.py`
creates one through `pypodlib.device.bootstrap.ensure_device_itunes_database`
at the point where something is about to be written.

**The trap that hid it for a whole release.** `pypodlib.connect()` on a
*virtual* iPod calls `ensure_virtual_itunes_database`, so a simulated device
rebuilds its own database the moment it is opened. Every device test uses
`create_virtual`, so the suite could not reach this path however many tests were
added. The regression test deletes the database *after* the handle is open,
which is the only way to hold a device in the state a real one arrives in.

The one refusal worth keeping: a device with audio files and no database. Those
files are already invisible to the iPod and an empty database makes that
permanent. That is somebody's music, so it stops and says what it found.

`ensure_device_itunes_database` returns `None` rather than raising when it
cannot produce a database the device's firmware would accept, so a falsy return
is a real failure and not a no-op.

### The way round sealed cookies is a browser of our own

Since the browser the user already runs cannot hand over its cookies on
Windows, `browser_login.py` starts one that can: their installed Chrome or
Edge, pointed at a profile under the app's own config directory, with the
DevTools protocol switched on. The user signs in in that window and the cookies
are read *out of the running browser* rather than off disk, so nothing is ever
decrypted and the sealing is irrelevant. The profile is kept, so the second
sign-in needs no typing.

Four things that cost time or would have:

- **It is `Storage.getCookies`, not `Network.getAllCookies`.** The connection is
  to the *browser* target and Network is a page-level domain, so the obvious
  call answers `'Network.getAllCookies' wasn't found` - which reads like a
  protocol-version problem and is not one.
- **No automation flags.** No `--headless`, no `--enable-automation`. A browser
  started that way sets `navigator.webdriver` and Google refuses to accept a
  password in it. The only switches passed are the profile, the port, and the
  two that stop a fresh profile opening onboarding tabs over the login page.
- **The WebSocket client is hand-written** (~90 lines in `browser_login.py`)
  rather than a dependency, because it only ever talks to one local process
  over an unencrypted socket. A signed-in cookie reply is tens of kilobytes, so
  the 16-bit length path and continuation frames are the *ordinary* case, not
  edges - `test_browser_login.py` covers both, and a truncated read would look
  exactly like a browser that did not sign in.
- **Signed-in is decided by a cookie, not by a URL.** `LOGIN_INFO`, `SID` or a
  `__Secure-*PSID` on youtube.com appears when an account is attached and not
  before. Reading the page's address instead breaks the next time Google
  changes a redirect.

### Backing up an iPod with two identical files failed on Windows

Found by the test isolation below, after it failed a release build.

pypodlib's backup store is content addressed and written by several threads.
Two files with the same bytes hash the same, so both threads write a temporary
blob and both rename it onto the same final name. Its own comment says that race
is "a harmless overwrite (same content, same hash)" - true on POSIX, and on
Windows renaming onto a path another thread still holds raises
`[WinError 5] Access is denied`. The snapshot is then discarded and `sync.py`
stops the run, because a backup that failed is not a backup.

The same track added to an iPod twice is enough to cause it.

`_install_backup_race_fix` in `device.py` handles it, **scoped as narrowly as it
can be**: `durable_replace` also writes the iTunesDB, the artwork database and
iTunesPrefs, where the target always exists and swallowing a failure would mean
reporting a sync that never happened. So it only intervenes when the destination
is named after its own hash - 64 hex characters, which only the blob store is -
and only when what is already there is the same size as what was being written.
A corrupt blob being repaired still fails, as it should.

### The test suite was writing to the real user profile

`config_dir()` and `backups_dir()` fall back to the platform's own locations,
and only some tests overrode the first while nothing overrode the second. So
every test that ran a sync took a real iPod backup into
`%LOCALAPPDATA%\SyncMyPodackups` - on the developer's machine and on the CI
runner.

That is untidy, and it also hid the bug above: a warm blob store makes the race
impossible to hit, because the pre-existing blob short-circuits the write. So it
passed locally for weeks and failed on a cold CI runner, intermittently,
depending on which tests ran first.

`tests/conftest.py` now points both directories at a per-test `tmp_path`. The
handover already said this about the workspace - "a claim about the shared temp
is a claim about every process on the machine" - and the same reasoning applies
to anything the platform chooses for you.

### The metadata badges are gone, and Unknown artist replaced them

Asked for on 15 September, and the data said it more strongly than the request
did. On the real library:

| metadata_state | tracks | of which no artist |
|---|---|---|
| resolved | 672 | 0 |
| unresolved | 14 | **14** |
| manual | 9 | **2** |

So "Unresolved" was a second name for "has no artist" - 14 of 14 the same set -
except that it was **worse** at saying it: two tracks corrected by hand read
`manual` while still having no artist, and the badge could not express that at
all. And `pending` had zero rows, because it only exists inside a running
import; that badge had never once appeared.

What replaced them:

- **No metadata badge on any row.** Not unresolved, not pending, not manual.
  "Manual" means the resolver will not overwrite an edit, which is worth saying
  once in the dialog that makes the edit rather than on every row forever.
- **An Unknown artist entry at the top of the Artists list**, counting songs with
  no artist credit and linking to them. They have no `track_artists` rows, so
  the artists query could never see them - they were invisible on that page. It
  is also what the iPod does with them.
- **Filters named for the song, not the state machine**: "No artist", "No
  artist, still flagged", "Failed to sync", "Manually edited".
- The Overview counts an empty `artist_credit` rather than a `metadata_state`,
  so it now includes those two `manual` tracks it had been missing.

`attention_dismissed` still does its job - it keeps a song out of the count -
but there is no "Accepted" badge any more. The Unknown artist list is where they
live, and the flagged count beside it says how many are still being counted.

**A pasted source link now clears what it answers.** `source_missing` is set
false and any `device_tracks` failure for that track is deleted, because both
describe a sync that ran before there was a link - and leaving them would mean
the song still read as broken after the thing that broke it had been fixed.
Nothing is lost: if the link does not work either, the next sync records the
failure again with whatever went wrong that time.

### Saving metadata returned a 500, and had done for as long as it existed

`TRACK_COLUMNS` in `services/library.js` selects `fail.error` and
`fail.device_name`, which only exist when `SYNC_FAILURE_JOIN` is in the same
query. Nothing enforced the pairing, `getTrack` was written without it, and
Postgres answered `missing FROM-clause entry for table "fail"` - so every
`GET /api/library/tracks/:id` and **every metadata save** returned a 500. The
browser showed "Something went wrong. Check the server logs."

Two things made it survive. The Songs list *does* include the join, so the page
those columns are most visible on worked perfectly. And the PATCH route writes
first and returns the updated track last - so the save succeeded and only the
read-back failed, which means the error message was not just unhelpful, it was
wrong. The edit had been applied every time.

Fixed structurally rather than by adding the join and hoping: `trackSelect(from,
extraColumns)` returns the columns *and* the join, so there is no way to ask for
one without the other. The two callers need different FROM shapes - one scoped
to a library, one looking up a track by id - which is why it takes the FROM as
an argument.

**A static check for this was tried and thrown away.** A script that looks for
`alias.column` with no matching alias in the FROM reported 202 findings on a
clean tree: it cannot tell a query from a fragment, and `EXCLUDED`,
`INSERT INTO`, LATERAL bodies and CTEs all look like violations. Alias
resolution needs a real SQL parser to be accurate, and a check that cries wolf
gets switched off. The structural fix is worth more than the linter would be.

### YouTube blocks a machine that syncs a large library

Measured on 13 September, straight after a 399-track sync: **every** search from
that machine returned six `Sign in to confirm you're not a bot` errors and zero
results. Not obscure tracks - "Queen - Bohemian Rhapsody" too. Signed out, the
tool could not download anything at all.

Two consequences.

**The sign-in is no longer about bitrate.** It was built for the 256kbps Premium
stream; it is now the difference between downloading and not. A signed-in
session is not subject to the check.

**The reason reached the user wrong.** A search runs with `ignoreerrors` so that
one withdrawn video does not lose the other five, which meant the bot check was
swallowed and every track was recorded as "No audio could be found for X" - so
ten failures looked like a metadata problem and were not. `_YtDlpLogger` now
watches for the marker, `_search_raw` raises `BlockedError`, and the run stops
rather than spending an hour failing every remaining track the same way.

**The ten failures from that run were NOT this, and saying they were was a
mistake worth recording.** The block was measured *after* the sync and was very
likely caused by it; that was then used to explain failures that happened
during it. Mohamed spotted the hole: a block that had started mid-run would
fail every track after it, and these ten were scattered through a run of 399.

Re-running the real searches once the block lifted gives the actual answer, and
it is the duration guard - see the next section. The lesson is the older one in
this file: measure the thing, at the time, rather than explaining it with
something measured later.

Whether four-at-a-time makes the block likelier is untested. The run that
triggered it was sequential, so volume rather than concurrency is the cause,
but it is the obvious thing to look at if it recurs.

### An iTunesDB holds its playlists twice, and only one copy counts

Reported as "the playlist is not on the iPod", and it was exactly that: the
database held "Liked" with 92 of its 94 tracks, `playlist_names()` listed it,
all 436 songs played, and the device's Playlists menu was empty.

**MHSD type 2 is the original playlist list. MHSD type 3 was added for the 5th
generation and is the one everything since reads.** pypodlib's
`create_playlist` appends only to type 2 - it calls type 3 "podcast playlists",
which is what the field was first used for and not what it means now. Parsed
straight off the real device:

```
mhsd type=1 child_count=436   <- tracks
mhsd type=3 child_count=1     <- playlists the iPod reads: the master, only
mhsd type=2 child_count=3     <- master, Liked, and a test playlist
```

`_mirror_into_dataset_three` in `device.py` copies each user playlist across
after it is written, taking the whole type 2 row so every field the writer
expects comes with it and only the dataset marker differs. The master is left
alone; the database writer already maintains it in both.

**It repairs itself, and that took a second change.** Every playlist this tool
wrote before 13 September went into dataset 2 only, so every device it has ever
synced is in the broken state. `playlist_contents()` - which answers "have the
playlists changed?" - read dataset 2, so it would have answered "no" and
skipped the write, leaving those devices wrong for good. It now counts a
playlist as present only when both datasets agree; one that exists only in
dataset 2 is reported as absent, because as far as the iPod is concerned it is.
The next sync then rewrites it.

Confirmed working on the real 5.5th gen on 13 September: "Liked" appears under
Music > Playlists with its 92 tracks.

**One wrong guess before this, worth keeping.** The first suspect was the
playlist's persistent id: pypodlib generates it with `random.getrandbits(64)`
and the one on the device was above 2^63, which a signed read would make
negative. Plausible, wrong, and disproved by writing an A/B pair to the real
device rather than reasoning about it - the low-id playlist did not appear
either. The id is still unsigned-64 and still probably worth masking one day,
but it is not this.

### Playlists are reconciled on every sync

`Plan.nothing_to_do` looked only at downloads, removals and artwork, so a run
where every song was already present reported "Already up to date" and never
touched the playlists - precisely the state somebody who has only reorganised a
playlist is in. `build_plan` now compares the device's playlists against the
library's, by name and by order, and a difference counts as work.

Noticed while testing it: the fixture audio carries no embedded cover, so
`artwork_missing` is non-empty on every run and "Already up to date" is
unreachable in the suite. A separate quirk, left alone.

### The duration guard is what actually failed those ten tracks

Re-run on 13 September with the block gone, all six results present and zero bot
errors:

| Track | Deezer says | What YouTube has | Verdict |
|---|---|---|---|
| M.H.R - Paapi | 174s | "MHR - PAAPI (Official Video)" 205s | 31s off |
| Zeeshan Ali - Saadgi | 132s | four uploads, 209-501s | 77-369s off |

`MAX_DURATION_DRIFT_SECONDS` is 12, and it is rejecting correctly: an official
*video* carries an intro the release does not, so its length genuinely differs
from the catalogue's. The gap is that for these artists no matching-length
upload exists at all - no "- Topic" auto-upload, which is the thing that
normally matches a release exactly.

So the guard is not wrong, it is *unsatisfiable* for regional and independent
artists whose catalogue entry and YouTube presence are different recordings.

**Resolved: a relaxed second pass, 40 seconds, longer only.** Mohamed chose 40
over the 60 that was offered. It runs only when the strict pass has found
nothing, so it can never displace a tight match; it allows longer but never
shorter, because longer is an intro and shorter is a clip; and it requires the
title *and* an artist to match with no barred word, having given up the length
signal that would otherwise carry the decision. Measured against the real
failures: Dooron Dooron and its Unplugged cut now match, while Saadgi (77s over)
and Maand X Jhol (barred "cover") still do not, which is right.


### One unwritable file used to end the whole run

Sync run 10, on the night of 12 September, stopped after 45 of 431 tracks with
`Could not write to the iPod: ...\syncmypod-run-632y7yvw\198\source.m4a`. The
message is the bare path because that is all pypodlib raises; reproduced against
a virtual device, a source file that is missing when `add_tracks` runs produces
exactly that string and nothing else.

`add_files` writes a batch and commits the database in one call, so anything the
device refuses took the batch and the run with it. An hour of downloading thrown
away over one track is the wrong trade, especially now the web tool can show a
failed track. `_commit_batch` therefore checks the files still exist before
handing them over, and `_write_batch` falls back to writing one at a time when a
batch is refused, so whatever is wrong fails alone.

**What made the file vanish is not established.** The workspace is under the
system temp directory, the run was the only one going, and `purge_abandoned`
will not touch a directory younger than six hours. Antivirus is the likeliest
candidate on Windows and is unproven. The run the next morning did all 399 with
no repeat. Worth re-opening only if it happens again - the handling is now
right whatever the cause.

That crashed run is also what left `syncmypod-run-632y7yvw` behind, which is
what `test_nothing_downloaded_is_left_behind` then tripped over. An earlier note
in this file blamed concurrent test runs for that; it was wrong.

### An iPod can only ever show one artist per track

Asked on 13 September, and the answer is the file format rather than a choice.
The iTunesDB stores **one artist string per track** - MHOD type 5 - and the
device's Artists menu is the list of distinct strings in that column. There is
no multi-artist structure to write, so a track credited "A, B" physically
cannot appear under both A and B. iTunes behaves the same way for the same
reason.

What *is* a choice is what goes in that one field. The tool currently writes the
full credit, so a soundtrack fills the Artists menu with entries like "Pritam,
Arijit Singh, Amitabh Bhattacharya". Writing only the primary artist would make
the menu browsable at the cost of losing the other names on the device; the
manifest already carries the structured `artists` list with roles and
positions, so either is a small change in `tagging.py`. **Offered on
13 September and declined** - Mohamed wants the full credit on the device. Do
not re-open it.

Related, and the reason it would have been awkward anyway: Deezer's contributor
order puts the composer first, so
the "primary" artist is not the first name in the credit.

### Chromium on Windows cannot hand over cookies, and never will

Three separate obstacles, and only the first is the one people assume:

- **The database is locked while the browser runs.** yt-dlp reports this as
  `Could not copy Chrome cookie database`, an errno 13 `PermissionError`
  underneath. Nothing in that string matches "locked" or "permission", which is
  why it was being misclassified.
- **App-Bound Encryption.** Since Chrome 127 each cookie value carries a `v20`
  prefix, and yt-dlp handles `v10` and falls back to DPAPI for anything else -
  DPAPI has no key for `v20`. Closing the browser does not help. Measured on
  Mohamed's machine: **961 of 961 Chrome cookies were v20**, while the app was
  telling him to go and sign in to Chrome.
- **Firefox may not be installed**, and it is the only one that works.

`_chromium_cookies_are_sealed()` copies the cookie file and counts the prefixes
rather than guessing, because "close it and retry" and "this can never work" are
opposite advice. **The `hex()` in that query is load-bearing**: `encrypted_value`
is a BLOB and SQLite never compares a BLOB equal to a text literal, so
`substr(encrypted_value,1,3) = 'v20'` is false for every row and every browser
comes back unsealed. That bug was written, and only caught because the answer
disagreed with a measurement taken by hand first.

The way through is a cookies.txt the user exports, which is what
`import_cookies_file()` accepts. Same filtering as a borrowed jar: everything
that is not youtube.com is dropped before anything is saved.

### Windows has no timezone database

`zoneinfo` reads the operating system's tz database, and Windows does not have
one. pyPodLib reads the timezone the iPod itself is set to, so on Windows
**every** iTunesDB parse failed outright — `ZoneInfoNotFoundError` for
`Europe/Dublin`, which is what the attached device happened to be set to. The
`tzdata` package is now a Windows-only dependency. Invisible until you try a
real device on a real Windows machine.

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

Needs `numpy` and `Pillow`, so the dependency is `pypodlib[artwork]`. Not
optional: without them the feature silently does nothing.

### Store Python hides the config and the backups

Python installed from the Microsoft Store runs in an app container that
redirects writes under `%LOCALAPPDATA%` into a per-package `LocalCache` tree.
The redirect is invisible to the writing process — it reads the file back from
the path it asked for — so `syncmypod status` reported a config path that File
Explorer insisted did not exist. The 1.2GB of iPod backups are in there too.

Not a bug, and it disappears once the app is packaged, because a PyInstaller
executable is an ordinary Win32 process. But the pairing made during development
does **not** carry over to the packaged build. The CLI prints `os.path.realpath`
of the config path, which resolves the redirect.

### YouTube's 256kbps stream needs an authenticated Premium session

Verified by listing formats on a real track. Signed out, the best available is
itag 140 (AAC, 129kbps) or itag 251 (Opus, 133kbps). Itag 141, the 256kbps AAC,
simply does not appear in the format list — it is offered only to a signed-in
YouTube Music Premium account.

So Opus is never the better choice despite the higher number: an iPod cannot
play it, so taking it means a re-encode that ends up worse than the AAC it beat.

Cookie extraction has two failure modes worth knowing. Chromium locks its cookie
database while running, and since Chrome 127 seals it with App-Bound Encryption
that another process cannot unwrap on Windows at all. **Firefox is the one that
works there.** Safari is only offered on macOS because yt-dlp refuses it
elsewhere.

### YouTube search works from the server without a key

Assumed it would need the Data API v3, because datacentre IPs are treated more
harshly than residential ones. Measured instead, from the deployment host: the
ordinary search page returns HTTP 200 with a full `ytInitialData` payload in
about half a second, and parses to twenty results. No key, no Google Cloud
project, nothing to set up.

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

### YouTube is replacing its page components mid-flight

Discovered building playlist import on 12 September. The playlist page no longer
contains `playlistVideoRenderer` at all — entries are now `lockupViewModel`,
with the title, channel and duration in entirely different places, and the
duration buried in a thumbnail badge several wrappers down.

Three consequences:

- **Both shapes are parsed.** A response during the changeover can carry a
  mixture, and reading only the new one would break again when a cached page
  serves the old.
- **The InnerTube JSON API returns the same new components.** Switching to
  `youtubei/v1/browse` does not avoid this — the WEB client is what migrated.
  It is used only for paging, where the continuation token is meaningless to
  anything else.
- **Things are found by shape, not by path.** The wrappers are exactly the part
  that keeps being renamed, so the parser searches for a recognisable node
  rather than following a fixed route into the tree.

Do not "simplify" these walkers back into direct property access. They are
defensive on purpose, and the page has already changed once during this
project's lifetime.

### The connected YouTube account was built twice and then removed

Worth keeping because the reasoning cost a day and the conclusion is not obvious
from the outside.

**Reading somebody's own playlists genuinely requires OAuth.** "Sign in with
Google" *is* OAuth - they are one mechanism, not two, and the developer-console
step is what makes the login button exist rather than an alternative to it.
Everything else a website could try is closed: asking for the password is
phishing and 2FA defeats it, framing `accounts.google.com` is blocked by
`X-Frame-Options: DENY`, and reading youtube.com's cookies from another origin
is what the same-origin policy exists to prevent. A client secret in a public
repository is not a secret.

**The local app's session is not a substitute.** A second attempt had the local
app read its signed-in account and push the list up, which needed nothing set
up. Mohamed's correction: that sign-in is a *borrowed* account kept for
downloading, so its playlists are somebody else's.

**So it went back to OAuth, and OAuth is what killed it.** Every instance owner
had to create a Cloud project, enable the API, register a client, paste two
values into Settings - and then, because `youtube.readonly` is a **sensitive
scope**, add their own address to that client's **Test users** list before
sign-in would work at all. Mohamed did all of it and still met
`Error 403: access_denied`, which is exactly what a missing Test users entry
looks like. Migration `008_drop_youtube_account.sql` removed it.

Following a public playlist link does the same job from five services and asks
for none of it. Do not rebuild this unless somebody genuinely needs their
*private* playlists followed, and knows what it costs them to set up.

### YouTube Music answers with real metadata, and that changes everything

The single biggest improvement to resolution quality in the project so far.

A YouTube *video* search gives a title like "Bebe Rexha & Faithless - New
Religion (Official Visual)" and a channel name, and turning that into an artist
and a song is guesswork that fails on every upload not following the convention.
YouTube *Music* is a different index over the same catalogue reached through the
same InnerTube endpoint with the `WEB_REMIX` client, and it returns the artist,
the album and the song as separate fields - each run tagged
`MUSIC_PAGE_TYPE_ARTIST` or `MUSIC_PAGE_TYPE_ALBUM`.

Measured on the same recordings:

    "Uyire"     YT Music fields -> resolved via Deezer, 0.85, ISRC INM811460611
                video title     -> unresolved
    "Kesariya"  YT Music fields -> resolved
                video title     -> unresolved

Both regional releases - exactly the case the YouTube fallback exists for - and
both now land with real credits instead of waiting for someone to type an artist
in. This is what `ytmusicapi` does; that library is Python and the web app is
Node, so what was ported is the method, not the code. No key, no account.

Three things about it:

- **`params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'` is "songs only".** Without it
  the response mixes in albums, artists and music videos, and a music video is a
  different recording from the song - usually with an intro and a different
  length.
- **Read the tags, do not split on the bullet.** The column renders as
  "Artist • Album • 4:29", but an artist with a bullet in their name would break
  a split, and the column's shape varies by result type.
- **The video search stays as the fallback.** YouTube Music indexes music;
  YouTube indexes everything. A track that only ever existed as somebody's
  upload is findable by the second and not the first.

### Sources are not imports

A distinction the UI now makes and the code should keep. An import happens once:
paste a link on the Import page and you get the playlist as it was that
afternoon. A **source** is the same link remembered, re-read whenever the
Sources page is opened, with anything new imported.

Sources are **additive only**. A track removed upstream stays in the library,
and removing a source keeps everything it brought. Same reasoning as the local
app never deleting a track it did not add: the cost of being wrong is somebody's
music, and "it disappeared" is a far worse failure than "it is still there".

Two details that will look like bugs if the reasoning is lost:

- **A check that finds nothing new deletes its own job row.** Otherwise
  following three playlists fills the import history with a row every half hour
  saying nothing happened.
- **A playlist that has gone private records the error against itself** rather
  than throwing, so it can be seen and acted on, and so one broken source does
  not stop the others being checked.

Other facts about both routes:

- **Saved albums are not exposed at all.** YouTube Music albums saved to a
  library are not playlists, and neither Google's API nor the pages list them.
  The card says so; an album is still importable by its playlist link, which
  YouTube Music offers from the album's share menu.
- **Watch Later and History are filtered out** of the local-app route. The first
  is a queue of videos rather than a music collection; the second is not a
  playlist at all.
- **Flat extraction is essential** there too. Without `extract_flat`, yt-dlp
  opens every video in a playlist in turn - thousands of requests for one liked
  list, and the surest way to be rate limited.
- **Liked songs are the `LL` playlist**, reached through
  `channels.list(mine=true).contentDetails.relatedPlaylists.likes`.
- **`access_type=offline` plus `prompt=consent` are both required.** Google
  issues a refresh token only on the *first* consent for a client and account,
  so a user reconnecting after a disconnect would get an access token, appear to
  connect fine, and stop working an hour later.
- **`snippet.channelTitle` on a playlist item is the playlist's owner**, not the
  uploader. The uploader is `videoOwnerChannelTitle`.
- Deleted and private videos stay in a playlist as rows titled exactly
  `Deleted video` and `Private video`, with no other metadata.
- Refresh tokens are encrypted at rest (AES-256-GCM, key derived from
  `SESSION_SECRET`). Rotating the session secret invalidates stored grants,
  which is correct — rotating it is what you do after a compromise.

### Reading a playlist from five services without a single key

`providers/playlists.js` detects the service from the address and reads it. One
box on Import, one on Sources; adding a service is a reader there and nothing
else.

    Spotify        open.spotify.com/embed/playlist/{id}  ->  __NEXT_DATA__
    Apple Music    music.apple.com/{cc}/playlist/...     ->  serialized-server-data
    YouTube        as documented above
    YouTube Music  same playlist ids, different host
    Deezer         its public API

**Spotify's Web API is still unavailable** and this is not a substitute for
trying it: it refuses every call unless the account owning the registered app
holds Premium. The embed page is the same data an `<iframe>` on any blog
already loads, and carries title, credited artists and duration.

Four things that cost time:

- **Apple Music wraps its tracks in shelves**, and a shelf holding the single
  card for the playlist itself matches the same shape. Taking the first match
  returned one "track" called "Today's Hits" by "Apple Music Hits". The
  *largest* list of items wins instead.
- **Apple Music's node titles are useless** - a shelf is called "Tracks" or
  nothing - so the playlist name comes from the page's `<title>`.
- **`spotify:playlist:ID` parses as a URL with an empty hostname**, so it has to
  be matched before the host checks, not after.
- **SoundCloud is not supported, deliberately.** Its pages are a JavaScript
  application with nothing server-rendered to read, so it needs a `client_id`
  scraped out of a JS bundle and then API calls. That is the one genuinely
  fragile option, and shipping it beside four stable readers would misrepresent
  how reliable it is.

**What a reader is trusted with is the important part.** Each declares a
`quality`, and that decides what survives a failed match:

    catalogue   Spotify, Apple Music, Deezer. The credits are records, so an
                unmatched track keeps them.
    upload      YouTube, YouTube Music. The "artist" was split out of a video
                title, so it is a search and is discarded if nothing confirms
                it - the metadata rule, unchanged.

### YouTube Music is a resolver tier, not a button

It sits at the end of the ladder, reached only when Deezer, iTunes and
MusicBrainz have all said no, which for this library means a regional or very
recent release.

**It is not in the scored provider list.** The scorer asks "does this candidate
match what you already know", and for a track whose only known field is a title
there is nothing to check against - every candidate scores about 0.5 and none is
ever accepted. Correct for a catalogue search, useless here, where YouTube
Music's answer *is* the metadata. So it is judged on its own terms, and those
terms took four passes over real data to get right:

- **Title overlap measured against the shorter title** gives a short generic
  answer a perfect score. "just us" by Gabriela Bee scored 1.00 against
  "JUST US - AASHIR WAJAHAT | KOMAL MEER" and was written to the library.
- **So the other direction is checked too:** everything significant in the
  upload title must be accounted for by the answer (`answerExplains`).
- **But not too literally.** Upload titles name actors ("Leher (Official Video)
  Shahid, Kriti, Rashmika") and uncredited duet partners ("Anne-Marie & Ed
  Sheeran - 2002"). Requiring every name cost every one of those a match.
- **So duration is ranked first, and checked before the title gate.** Within
  five seconds identifies a recording about as well as anything short of an
  ISRC. Checking it after the gate threw away "2002 (Acoustic)", five seconds
  out, in favour of plain "2002", nineteen seconds out.

**And it searches the ORIGINAL title**, not the decoration-stripped one.
`stripDecorations` removes "(From 'Brahmastra')" because the licensed catalogues
file it that way; YouTube Music does the opposite and indexes film music *with*
the film. Handing it the stripped title meant every search ran, every search
succeeded, and every one returned the wrong record. That one cost an afternoon.

### Unresolved songs sync, with empty fields

They used to be held back, which meant a song somebody deliberately added never
reached the device and the only remedy was typing an artist by hand. Mohamed
asked for the opposite and he was right.

An unresolved row already stores an empty artist and a null album, so the
manifest writes exactly those and the iPod files it under Unknown Artist -
honest, visible, and fixable later. `pending` is still held back: that means
resolution has not been attempted yet rather than attempted and failed.

The source URL travels with the track in `library_tracks.source_hint`, and the
local app short-circuits its YouTube search when one is present. That matters
most for exactly these tracks: a title-only search for a song with no artist is
the weakest search there is.

### Splitting a combined artist credit, without inventing band members

The Artists page listed people who do not exist: "Pritam & Soham", "Kailash
Kher, Naresh Kamath & Paresh Kamath". iTunes reports every credited artist as
one string and gives no structured list; Deezer gives a proper contributor list.
Every combined row in the library had an `itunes_id` and no `deezer_id`.

**Do not split on punctuation.** The counter-example is in the library:
**Earth, Wind & Fire** is one band, and so are Simon & Garfunkel, Hall & Oates,
Blood, Sweat & Tears. Splitting those invents members, silently and permanently.

Two discriminators were tried and both are wrong:

- *"The whole name exists as an artist, so leave it."* Deezer files
  collaborations as artists too - "Alan Walker & Ava Max" is a real entry, id
  80722242 - so existence separates nothing.
- *"All the parts exist, so split it."* Earth, Wind and Fire are each also
  artists on Deezer. This shatters the band.

**What works is follower counts**, and it is not a close call in either
direction:

    Earth, Wind & Fire     1,264,655 fans   best part     1,759    x719
    Simon & Garfunkel      1,165,520 fans   best part     3,053    x382
    Alan Walker & Ava Max      1,996 fans   best part 4,052,443   /2030
    BUNT. & Malou                 12 fans   best part    13,979   /1165

A band is what its audience follows; a collaboration is a footnote to two
artists who each have one of their own. So the whole name stays whole only when
it is at least as followed as its biggest part. `deezer.toArtist()` carries
`fans` for this, populated by `/search/artist` and absent from a track's
contributor list.

Three more things that cost a round each:

- **Normalising punctuation away is not the same as ignoring it.** Stripping it
  entirely makes "Soham" and "So Ham" the same string, and Deezer has both - the
  first run credited a song to the wrong artist. Punctuation becomes a space.
- **The album artist comes in through a different door.** `upsertAlbum()`
  creates it separately from the track's artists, so expanding only
  `track.artists` let the combined string keep arriving. The rows it made had no
  `track_artists` links, which made them look like a database fault rather than
  an import one. Both are expanded now, before the transaction, because the
  expansion calls out to Deezer and holding a transaction across a network
  request is how a pool runs dry.
- **`albums.album_artist_id` is ON DELETE SET NULL.** Deleting a combined artist
  without moving its albums first silently left seventeen albums with no artist
  at all. `repairOrphanedAlbums()` puts them back by re-deriving from each
  album's own tracks. Check `SELECT count(*) FROM albums WHERE album_artist_id
  IS NULL` after anything that deletes an artist.

`artist_credit` on the track is deliberately never touched by any of this. That
string is the iPod's artist tag and "Kailash Kher, Naresh Kamath & Paresh
Kamath" is the correct tag. Only the browse-by-artist structure was wrong.

### Two undefined-reference bugs shipped, so CI now checks for them

`node --check` parses a file and stops. It has no idea whether `loadJobs()`
refers to anything, and twice that gap put a broken page in front of the user:

- A slice taken from one comment marker to the next removed the YouTube account
  card **and** the `loadJobs` definition sitting between them. The Import page
  rendered "loadJobs is not defined" and nothing else.
- A route used `rateLimit` that its file never imported. The container
  restart-looped on startup.

`web/scripts/check-references.mjs` now runs in CI. It imports every server
module for real - a missing import at module scope fails there - and scans every
file for identifiers called but never defined. No new dependency.

It was verified against both original bugs rather than assumed to catch them,
and tuned until it was clean across all 53 files. The false positives worth
knowing about, because they will come back if it is rewritten: `async (`, class
and object method shorthand, `for...of` bindings, destructured parameters, and
text inside regex literals. It also skips `scripts/` - its own source contains
backticks inside regex literals, which its own string-stripper cannot pair - and
skips `server/index.js`, which starts a listener as a side effect of import.

### Re-matching songs that arrived with no artist

A track stored with a title and nothing else was close to unmatchable, because a
title alone does not identify a recording. YouTube Music changed that, so
`services/rematch.js` walks the unresolved tracks, asks YouTube Music, and puts
the answer to the ordinary resolver. On the real library: 24 examined, 4
identified with correct credits and real ISRCs, 20 genuinely not in any
catalogue and left untouched.

**It merges rather than updates, and that is the hard part.** A resolved track's
identity comes from its ISRC, so it gets a different `match_key` and therefore a
*different row* - often one that already exists, because the same recording may
already be in the library from a search. So `library_tracks`, `playlist_tracks`
(positions included) and `device_tracks` are moved onto the resolved row in one
transaction before the old one is deleted. Anything that resolves an existing
track has to do this or it will duplicate rows and drop playlist entries.

Guards, because this runs unattended over a whole library: a candidate whose
title shares too few words with the original is refused, and so is one more than
fifteen seconds off the known duration.

### What packaging found

Freezing the application surfaced two bugs that source runs had hidden, which is
the argument for packaging before furnishing rather than after.

**A Malayalam track title crashed the sync.** Windows consoles default to a
legacy code page, and rich's Windows renderer encodes to it — so printing the
progress line for a track whose name is outside cp1252 raised
`UnicodeEncodeError`, which propagated out and killed the run. Fixed by
switching the console to UTF-8 at *import* rather than in `main()`, because rich
reads a stream's encoding when the Console is constructed.

**The workspace prefix was too broad.** `purge_abandoned()` deleted anything in
the temp directory matching `syncmypod-*` that was a few hours old — which
included `syncmypod-build`, PyInstaller's working directory. A sync running
during a build would have deleted it. The prefix is now `syncmypod-run-`.

Other things worth knowing about the build:

- **Submodules are collected wholesale**, not listed. pypodlib defers nearly
  every internal import into the function that needs it, and reaches the artwork
  writer through a module-level `__getattr__`; PyInstaller's static analysis
  sees none of it.
- **PyInstaller hits Windows' 260-character path limit easily.** The build
  script defaults to a short temporary path for that reason.
- **A folder, not one file.** One-file mode unpacks the bundle on every launch,
  which with 148MB of ffmpeg is a ten-second startup. The zip keeps the download
  to a single file.
- **ffmpeg is the shared LGPL build on Windows**: 148MB against 255MB for the
  static one, because the two executables share DLLs instead of each embedding
  every codec. Linux stays static, where a shared build would need an rpath fix.
- **A double-clicked executable owns its console**, which is how the GUI is
  launched without a subcommand: `GetConsoleProcessList` returning 1 means
  nothing else is attached, so the window was not opened from a shell.

### CI was red for four commits, for two reasons, neither in the code under test

Worth recording because both were misdiagnosed at first.

**The runner had no ffmpeg.** The sync tests genuinely convert audio rather than
mocking the transcoder — the conversion is the part most likely to break, so
faking it would prove nothing — and neither runner image carries ffmpeg. Every
sync test failed with "ffmpeg could not be found", which reads like a product
bug and is not one: the shipped application bundles its own copy. Linux now
`apt-get`s it; Windows fetches the bundled copy *before* the tests rather than
only before packaging.

**`shutil.rmtree(onexc=...)` is Python 3.12 and later.** The matrix floor is
3.11, and that failure had been hidden behind the missing ffmpeg. The keyword is
now chosen by version; the two forms differ only in the third argument they hand
the handler, and the handler ignores it.

A third thing, about diagnosis rather than code: **the PAT on the server cannot
read the Actions API** (403) or create releases, so CI logs were unobtainable
from there for days. The token in Git Credential Manager on Mohamed's Windows
machine has `repo` + `workflow` scope and can do both. Use that one.

### Infrastructure traps

- **OCI drops inbound ports before they reach the host.** A firewalld rule is
  not enough. The security list that matters is the one attached to the
  *instance's subnet* — Compute → Instances → Oralux → Primary VNIC → Subnet →
  Security Lists. Mohamed initially edited a list that had no rule for port 22
  or 8443 even though both worked, which proved it was not the one in force.
- **Ports 80 and 443 belong to the Mango dashboard's Caddy**, which must not be
  touched. That is why SyncMyPod is on 8444 and why its certificate uses the
  **DNS-01** challenge — HTTP-01 needs port 80, TLS-ALPN-01 needs 443, and
  neither is available.
- **`curl https://127.0.0.1:8444` returning 000 is not a fault.** curl sends no
  SNI to a bare IP, so Caddy cannot select a certificate. Test the app directly
  on `http://127.0.0.1:3010`, or use
  `curl --resolve syncmypod.duckdns.org:8444:127.0.0.1 ...`.
- **`/root/syncmypod` on the server is an rsync target, not a clone.** The web
  files sit at its root. Deploy by syncing `web/*` there — do not `git pull` into
  it expecting the repository layout.
- **Creating a release through the API also creates the tag**, which triggers
  `release.yml`. That run was cancelled on 12 September to stop it overwriting a
  hand-verified asset with its own build.

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
  because album titles diverge between services. The album is a scoring signal
  only, never a filter.
- MusicBrainz models every live performance as its own recording, so a
  well-known song returns the studio take buried among identically-titled
  bootlegs. Release quality is scored and subtracted.
- A track row numbered from `.map(trackRow)` starts at zero, which is falsy —
  so the first row of every "Popular" list fell through to showing artwork while
  every row below it was numbered.

---

## 6. What is next

Roughly in the order it is worth doing.

### 1. A web-side test suite, and a route smoke test first

Still none, and it is now the clearest gap. Four bugs reached the user's screen
in three days and every one would have been caught by the simplest possible
test:

- the Import page threw `loadJobs is not defined`;
- a route used `rateLimit` its file never imported, and the container
  restart-looped;
- Settings returned 500 on every load because a handler's parameter is named
  `_req` and the new line said `req`;
- `api.importJob` was called by two views and was never on the api client, so
  every import and every re-match died at "Lost track of the import" the
  instant it started.

`scripts/check-references.mjs` now catches the first two and the fourth. It did
**not** catch the third, and cannot: it flags identifiers *called* as functions,
and `req` there is an argument.

**Start with a route smoke test.** CI already runs Postgres for the migrations
job. Boot the app against it, request every GET route, and assert nothing
returns 500. That is perhaps forty lines and would have caught the first three.

A smoke test would **not** have caught the fourth, and that is the point worth
taking from it: the route was fine and the server finished every job correctly.
What was broken was the browser's ability to read its own progress. A web test
suite has to run the page, not only the routes.

Then unit tests, which need no new dependency - Node has `node --test`. The
resolver, `lib/normalise.js` (`matchKey`, `scoreCandidate`, `titleOverlap`,
`answerExplains`) and `services/artist-split.js` are pure logic with real
regression history; the band list in section 5 is ready-made fixtures.

### 1a. Work out what else the simulated iPod is hiding

`create_virtual` is the right tool and it is how the sync path gets tested
without hardware. But it is not a real device, and one difference had been
silently covering a bug that reached a user: a virtual iPod rebuilds its own
database on connect, so the whole device suite starts from a state a freshly
restored iPod is never in.

That is one known difference. Nobody has looked for the others, and they are
exactly where the next hardware-only bug lives. Two worth checking first:
whether a virtual device ever reports the artwork store as absent the way a
restored one does, and whether free space behaves the same when it is reported
by `shutil.disk_usage` on a simulated folder rather than a FAT32 volume.

### 1b. Watch what four-at-a-time does to YouTube

The sync fetches `DEFAULT_CONCURRENCY` tracks at once now, which is the
difference between about an hour and about twenty minutes on a 433-track
library. Four was chosen against one data point: a 12 September run took a
`403 Forbidden` after eighteen downloads in quick succession, and recovered on
the next run.

That number has not been tuned against a long run at four. If 403s start
appearing in a report, the lever is `--at-once` on the command line, and the
right fix is probably a small delay between submissions rather than dropping
back to one.

### 2. A local-files source

The highest-quality option available and the only one with no downside: point
the local app at a folder of music already owned, match manifest tracks against
it, and skip downloading entirely. The iPod Classic plays Apple Lossless, so a
CD rip goes on untouched. Discussed on 11 September and deferred; the engine
already has every piece it needs.

Now the *only* remaining quality lever that is free, after 15 September's
measurements. What else was surveyed that day, so it is not surveyed again:

| Source | Free audio | Verdict |
|---|---|---|
| YouTube Opus | 145kbps, 20kHz | **Taken.** The best free stream for this catalogue |
| YouTube AAC | 129kbps, 15.8kHz | What the tool used to take |
| YouTube Premium | 256kbps AAC, no conversion | Better, and not free |
| SoundCloud | ~128kbps MP3 / 64kbps Opus | Worse. 256kbps AAC is Go+ only - it is in yt-dlp's extractor as `256 if is_premium` |
| Bandcamp streaming | 128kbps MP3 | Worse. Lossless exists only behind a purchase or a name-your-price download, and only where the artist offers one |
| Deezer, Spotify, Tidal, Apple | - | Paid and DRM'd. Not reachable |
| Internet Archive, Jamendo, FMA | Lossless | Real, but live recordings, public domain and CC catalogues - not the library this syncs |

So for mainstream commercial music there is nothing free above YouTube's Opus.
The two things that beat it are a Premium subscription and the user's own files.

### 2a. Refetching what is already on the device

Not done, and not asked for. The 453 tracks synced before 15 September were
downloaded as 15.8kHz AAC, and the ledger correctly sees them as present, so
they keep the quality they were synced at. Re-fetching them would mean hours of
downloading and deleting files that are already there, which is the user's call
rather than a default.

`build_plan` is where it would go - the branch that appends to
`already_present` - paired with a removal of the old file once the new one has
landed.

### 3. A "needs attention" view

15 songs have a title and no artist. They *do* sync now - with the fields blank,
so they arrive on the iPod under Unknown Artist - which makes this untidy rather
than blocking. A further 7 could not be fetched at all and are a different
problem with a different fix: a source URL rather than an artist name.

Both are visible now, which they were not before 13 September: the Overview
carries a banner for each, and the Songs filter has `state=unresolved` and
`state=sync-failed`. What is still missing is a way to *act* on them in bulk.
Re-matching has taken everything YouTube Music could identify, so the remaining
15 genuinely need a human, and editing them one at a time from the Songs list is
the only way at the moment. A filtered view with inline artist entry is the
obvious next step, and both halves already exist: the filter, and a field that
autocompletes against the library.

### 4. macOS and Linux builds of the local app

PyInstaller does not cross-compile. Linux means adding a runner; macOS means
that **and** resolving the ffmpeg licensing question, since every readily
available static macOS build is GPL and this project is MIT —
`fetch_ffmpeg.py` refuses macOS rather than quietly bundling one.

### Open questions, not yet decided

- **SoundCloud.** The only one of the six services asked for that is not
  supported, because its pages are a JavaScript application and reading it needs
  a `client_id` scraped from a JS bundle. Worth doing only if somebody actually
  wants it, and worth marking as the fragile one when they do.
- Whether to strip `(From "...")` suffixes from titles before writing tags. They
  currently reach the iPod verbatim.
- Deezer's contributor order puts the composer first, so Kesariya reads
  "Pritam, Arijit Singh, …" rather than leading with the singer. Faithful to the
  source; may not be what he wants on the device.
- HSTS is still `max-age=0`. Ready to enable, deliberately not done — it is a
  one-year browser commitment with no quick undo.
- Code signing for the Windows build. Defender flags every unsigned PyInstaller
  executable, and the release notes say so, but saying so is not a fix.
- **Furnishing.** A first pass is done — dead CSS removed, the local window's
  cards no longer stretching to a common height, disabled buttons legible,
  keyboard focus visible throughout, empty states inside cards rather than
  floating between them. What is left is taste rather than defect.
  `web/public/css/theme.css` is all tokens and the local app's GUI carries a
  copy, so re-theming is two files that must be kept in step.

---

## 7. Working conventions

- **Commits** explain *why*, not what. The diff shows what changed; the message
  should say what problem it solves and what was traded away.
- **Comments** explain reasoning, not mechanics. Prefer one paragraph on why a
  thing is the way it is over a line-by-line narration.
- **Verify, don't assume.** Several documented "facts" turned out wrong when
  checked against the real library or a real request. Run the thing.
- **Report failures plainly.** If a test fails, say so with the output.
- **No secrets in the repository.** `.env` and `config.json` are gitignored.

### Two test runs at once will fail, and not for a real reason

pypodlib's device write guard is a machine-wide lock keyed by the *volume*, and
every virtual iPod the suite creates lives under `tmp_path` - which is the same
volume for all of them. So a second `pytest` started while one is running
contends for that lock, and the losing run fails in `IpodDevice.backup` with

```
Could not back up the iPod database: Another iOpenPod process is using this
backup location.
WARNING pypodlib.device.write_guard: Could not release iPod writer lock
cleanly: [Errno 13] Permission denied
```

Nothing is wrong with the code. **Run one suite at a time.** This wasted time
on three separate occasions on 13 September, twice sending the search after a
"leak" of download folders that was the other run's.

Stale lock files accumulate at `%TEMP%\pypodlib-device-locks` - one per device
path, so hundreds after a few runs. Harmless, and safe to delete.

### Tests

The Windows machine has Python 3.13. The venv is kept outside the project
directory because that directory is synced to OneDrive and a venv is thousands
of files:

```bash
python -m venv "$USERPROFILE/.venvs/syncmypod"
"$USERPROFILE/.venvs/syncmypod/Scripts/python" -m pip install -e "local[dev]"
cd local && "$USERPROFILE/.venvs/syncmypod/Scripts/python" -m pytest
```

Run **all three** checks before pushing, not just the tests — CI runs
`ruff format --check` too, and a formatting-only failure has already cost a red
build:

```bash
cd local
"$USERPROFILE/.venvs/syncmypod/Scripts/python" -m ruff check src tests
"$USERPROFILE/.venvs/syncmypod/Scripts/python" -m ruff format --check src tests
"$USERPROFILE/.venvs/syncmypod/Scripts/python" -m pytest -m "not hardware"
```

The full suite takes about three minutes; most of it is writing and signing
simulated iTunesDB files, which is the part worth not mocking. The tests need
ffmpeg on `PATH` or in `_bin` — they convert audio for real.

### Checking the web tool

There is no test suite, so these two are the whole safety net. Run both before
deploying:

```bash
cd web
find server public -name '*.js' -exec node --check {} \;
node scripts/check-references.mjs .
```

The second needs the dependencies installed. Without a local Node, run it the
way CI does, in a container - but against a staging copy rather than the deploy
directory, so a tree that fails the check never becomes the live one:

```bash
tar -czf - -C web --exclude=node_modules --exclude=.env . \
  | ssh root@100.96.249.123 'rm -rf /root/staging && mkdir -p /root/staging && tar -xzf - -C /root/staging'

ssh root@100.96.249.123 'docker run --rm -v /root/staging:/src:ro -w /work node:22-alpine sh -c "
  cp -r /src/server /src/public /src/scripts /src/package.json /work/
  find server public scripts -name \"*.js\" -o -name \"*.mjs\" | while read f; do node --check \$f || echo \"FAIL \$f\"; done
  npm install --silent >/dev/null 2>&1
  DATABASE_URL=postgres://unused@localhost:5432/unused SESSION_SECRET=ci node scripts/check-references.mjs .
"'
```

Both checks in one pass, on the exact bytes about to be deployed, on a machine
that has Node. The Windows box does not.

### Deploying a change to the web tool

```bash
tar -czf - -C web --exclude=node_modules --exclude=.env . \
  | ssh root@100.96.249.123 'tar -xzf - -C /root/syncmypod'
ssh root@100.96.249.123 'cd /root/syncmypod && docker compose up -d --build app'
```

Migrations apply automatically at startup. `--build` is not optional: the source
is `COPY`ed into the image, so `restart` re-runs the old build.

**The deploy never deletes.** `tar -x` only extracts, so a file removed from the
repository lives on at the server and keeps being imported. Remove it there too:

```bash
ssh root@100.96.249.123 'cd /root/syncmypod && rm -f server/services/gone.js'
```

`check-references.mjs` catches this, because the orphan still tries to import
things that no longer exist. That is how it was found.

### Building and publishing the local app

```bash
cd local
python scripts/build.py            # fetches ffmpeg, then PyInstaller
python scripts/build.py --skip-ffmpeg   # when _bin is already populated
```

Writes `local/dist/SyncMyPod-<version>-windows-x64.zip`. Pushing a `local-v*`
tag makes CI do the same and publish a release with the zip attached.

**Check the zip is actually current before handing it over.** On 11 September a
build predating the pairing commit was described as up to date; Mohamed caught
it. A quick check:

```bash
cd local/dist && unzip -p SyncMyPod-*.zip '*/_internal/**/app.js' | grep -c renderPairingForm
```

---

## 8. Loose ends

- **The library is Mohamed's own music.** Earlier versions of this file called
  it test data; that stopped being true on 12 September. Do not clear it. The
  numbers are in section 1.
- **15 songs have a title and no artist**, and **7 could not be fetched at
  all.** Both are visible now - the first on the Overview and under
  `#/library?state=unresolved`, the second under `#/library?state=sync-failed`.
  The first needs a human to type an artist; the second needs a source URL
  pasted on each.
- **One device is paired**: MANR-LT001. The four older rows were revoked on
  12 September and are only of historical interest.
- **Two different iPods have been used, and the current one is blank.** The
  earlier device was "Nihal's ipod", a Classic 6.5th gen (MB562, `HASH58`) with
  184 tracks already on it; there is a full backup in
  `%LOCALAPPDATA%\SyncMyPod\backups` taken before the first write, so restoring
  it exactly is `IPod.restore(snapshot_id)`.

  The one in use now is a **5.5th gen 80GB (MA450, serial 8K719QF4V9R,
  `ChecksumType.NONE`)**, mounted at `D:` when plugged in. It arrived restored
  and never synced, with no database at all - which is what produced the
  "iTunesDB was not found" failure, see section 5. It now holds **436 tracks and
  the "Liked" playlist with 92 of its 94**, and Mohamed has confirmed the
  playlist shows on the device under Music > Playlists.
- **The paired-device config on disk may be stale.** On 13 September
  `%LOCALAPPDATA%\SyncMyPod\config.json` named device "Mo Desktop", whose token
  had been revoked, while the running GUI reported itself as "MANR-LT001" and
  worked. The running process and the file disagreed and the cause was never
  established. **If the app starts up unpaired, that is why** - re-pair from the
  GUI and it is fixed.
- **Mohamed was running 0.1.3 while 0.1.6 was being built.** Anything synced
  from a build older than 0.1.6 writes playlists to MHSD 2 only, which undoes
  the playlist on the device. Worth checking `syncmypod.exe --version` before
  debugging a playlist that has gone missing again.
- **`local/src/syncmypod_local/_bin` holds ~149MB of ffmpeg** and `local/dist` the
  built zips. Both gitignored, both inside a OneDrive-synced folder, so they sync
  anyway. Moving the project out of OneDrive was offered and never answered;
  deleting `_bin` is safe and `fetch_ffmpeg.py` gets it back.
- **`Desktop/Claude/syncmypod-local`** is the redundant original local-app
  repository. Its commit is preserved under `local/`. Safe to delete.
- **Temporary accounts are how the UI gets checked**, because the `mo` password
  is not recorded anywhere. Several were created and deleted during this work
  (`uitest`, `vtest`, `mtest`, `vt`); `DELETE FROM users` cascades cleanly and
  left no orphan rows. Make one the same way:
  ```bash
  ssh root@100.96.249.123 'cd /root/syncmypod && docker compose exec app npm run create-user -- checkme "<password>"'
  ```
  **Delete it afterwards.** A live session against a deleted account looks like
  a broken page, which wasted a round of debugging once.
- A pairing code can be minted directly when a browser session is not available:
  ```sql
  INSERT INTO pairing_codes (code, user_id, expires_at)
  SELECT 'ABCD1234', id, now() + interval '20 minutes' FROM users LIMIT 1;
  ```
- **Check these two after anything that deletes artists or merges tracks.** Both
  have been silently wrong once:
  ```sql
  SELECT count(*) FROM albums WHERE album_artist_id IS NULL;           -- expect 0
  SELECT count(*) FROM playlist_tracks pt
    LEFT JOIN tracks t ON t.id = pt.track_id WHERE t.id IS NULL;       -- expect 0
  ```

---

## 9. Start here if you are picking this up cold

Read sections 2 and 3 first - the premise, and the metadata rule. Then this.

### The state of play in three sentences

The web tool and the local app both work end to end, and the local app is
published as **0.1.6** with the Windows build attached to the release by CI.
Metadata comes from four sources in a fixed order and needs no keys; playlists
can be imported or followed from five services, also with no keys. The web half
still has no tests at all, which is where the next bugs will come from and where
the next work should go.

**If you are picking this up after 13 September**, the three things most likely
to matter are: playlists go in MHSD 3 or the iPod cannot see them; YouTube will
block a machine that syncs a large library, and that is not the same as a track
being missing; and the duration guard is unsatisfiable for artists with no
"- Topic" upload, which is why the relaxed 40-second pass exists.

### What was built on 12 September, and why

| Change | Why |
|---|---|
| YouTube Music ported from ytmusicapi's method | Structured artist/album/song instead of a video title to guess at |
| YouTube Music as resolver tier 4 | It is a metadata source, so it belongs in the resolver rather than behind a button |
| Unresolved songs sync with empty fields | Holding them back meant a song somebody added never reached the device |
| One playlist box, five services | The address says which service it is; asking the user first was a question with an obvious answer |
| Artist credits split, unconfirmed parts kept | The Artists page listed people who do not exist |
| Metadata autocomplete | The library already held "Garvit - Priyansh" *and* "Garvit-Priyansh" |
| Phone layout | Mohamed expects a phone to be the device most used |
| Reference checker in CI | Two undefined-reference bugs shipped in one day |
| Connected YouTube account removed | It could not work until somebody edited a Google console |

### What was built on 13 September, and why

Three bugs Mohamed reported from his own screen, then everything that came out
of chasing them.

| Change | Why |
|---|---|
| `api.importJob` added | Two views called it and it did not exist, so no import could report its own progress |
| The api client checked in CI | The scan ignores anything after a dot; `api` is one literal in one file and worth the exception |
| List rows wrap on a phone | `.list-main` may shrink to nothing and `.list-actions` may not, so every card list read one word per line |
| Metadata column dropped from Songs | It was blank on almost every row by design; the marker now sits against the title |
| A blank iPod gets a database | A restored device has none, and without one it cannot hold music at all |
| The browser diagnosis reaches the user | It was computed per browser and thrown away for one fixed sentence that was wrong |
| A cookies.txt can be handed over | The only route left on Windows with sealed Chromium cookies and no Firefox |
| Sign-in opens a browser of its own | Asked for on 13 September; it is the only route that works without the user installing anything |
| Four downloads at a time | The slow part of a sync is the network and it parallelises cleanly; the device write does not and stays serialised |
| Failed syncs surfaced on the web | The local app has always reported them and the server has always stored them; nothing showed them |
| An Eject button in the local app | Cancel already tidied up, but nothing told the user when Windows had finished writing |
| One bad file fails alone | A single missing download ended a 431-track run after 45 |
| The progress line says when a run has stopped | It held the last step's text forever, so a finished sync still read as one in progress |
| YouTube's bot check is recognised | It was being reported as the track not existing, which is a different problem with a different fix |
| Failed tracks on the Overview | Asked for on 13 September; the Songs filter alone was not where anyone looks |
| Playlists written to MHSD 3 | The iPod reads dataset 3 for playlists; pypodlib only ever wrote dataset 2 |
| Playlists reconciled every sync | A playlist edit is work even when every song is already on the device |
| A relaxed 40s pass for longer uploads | The catalogue's duration is the release's; YouTube often has only the video, with an intro |

### Fourteen things that were got wrong first

Every one of these was written, deployed, and then corrected. They are the
cheapest thing in this file.

1. **Treating "Sign in with Google" as an alternative to OAuth.** They are one
   mechanism. The console step is what makes the login button exist.
2. **Assuming the local app's YouTube session could stand in for the user's
   own.** It is a borrowed account kept for downloading.
3. **Splitting artist credits on punctuation** - and then over-correcting into
   refusing a whole credit over one unconfirmable name.
4. **Handing the YouTube Music tier a decoration-stripped title.** Every search
   ran, every search succeeded, every one returned the wrong record, and nothing
   looked broken.
5. **Deleting a combined artist without moving its albums**, when the foreign key
   is `ON DELETE SET NULL`. Seventeen albums silently lost their artist and it
   was only noticed because the count matched the number of splits.
6. **Expanding only the track's artists and not the album's.** `upsertAlbum`
   creates the album artist down a different path, so combined rows kept
   reappearing with no tracks attached, which looked like a database fault.
7. **Slicing code between two comment markers.** It ate a function definition
   (`loadJobs`, which broke the Import page), and on a second occasion six
   unrelated functions. **Bound every replacement by the exact thing that
   follows it, and check the function list afterwards.**
8. **Trusting that a deploy removes deleted files.** The tar deploy only
   extracts. A module deleted locally kept being imported on the server until it
   was deleted there too.
9. **Adding a method to two callers and not to the client.** `api.importJob`
   was written into the import dialog and the re-match dialog and never onto
   the `api` object. Nothing caught it, because the reference scan stops at a
   dot. Every import looked broken while the server was finishing every one of
   them correctly.
10. **Comparing a SQLite BLOB to a text literal.** `substr(encrypted_value,1,3)
   = 'v20'` is false for every row, because SQLite never compares a BLOB equal
   to text. The sealed-cookie detector reported every browser as fine and would
   have given confidently wrong advice. Caught only because the answer
   disagreed with a count taken by hand first - `hex()` both sides.
11. **Moving a badge out of a dropped column without measuring the phone.**
   Removing the Metadata column and putting the marker beside the title is
   right on a desktop. On a 375px screen the title cell is about 200px and the
   badge is 73 of them, which left a title two characters long - worse than
   what was replaced. Measured, not seen: the number is what showed it.
12. **Explaining a failure with a measurement taken afterwards.** Ten tracks
   failed a sync; a bot check was found on that machine hours later and blamed
   for them. Mohamed asked why the ten were scattered through 399 rather than
   in a block - which a mid-run block would produce - and the explanation fell
   apart. The real cause was the duration guard. The block was real, but it was
   a *consequence* of the sync, not a cause of anything in it.
13. **Three explanations for the same bug, two of them from the API.** The
   playlist that would not appear on the iPod was blamed on the bot check, then
   on the persistent id exceeding 2^63. Both were reasoned from what pypodlib
   exposes. The answer came from parsing the iTunesDB bytes and counting the
   MHSD datasets, which took ten minutes and should have been first.
14. **Running two test suites at once, three times.** pypodlib's write guard is
   a machine-wide lock keyed by volume, so the second run fails in `backup()`
   with a permission error that reads like a real bug. Twice it sent the search
   after a "leak" of download folders that belonged to the other run. See
   section 7.

### Five habits that paid for themselves

- **Measure on the real library rather than reasoning about the code.** The
  YouTube Music guards took four passes and every correction came from looking
  at what it actually matched, not from thinking harder.
- **Run the reference check before deploying.** It has caught a missing import
  three times, including one introduced while fixing something else. Stage the
  tree in `/root/staging` and run it there rather than over `/root/syncmypod`,
  so a failure never reaches the deploy directory.
- **Prove a new check fails before trusting that it passes.** The api-client
  check was verified by deleting the fix from the staging copy and watching it
  name both callers by line. A check that has only ever been seen to pass has
  not been seen to work.
- **Clean up test data immediately.** Two imports of 50 tracks each went into
  Mohamed's real library during testing; both would have reached the iPod on the
  next sync.

- **Ask the device, not the library.** Two of the three wrong answers above
  came from reasoning about pypodlib's API. Reading the raw iTunesDB, and
  writing an A/B pair to the real iPod to test a theory, is what actually
  settled both the playlist bug and the one before it.

### The one thing to do next

**A web test suite**: a route smoke test first, then something that runs the
page. CI already runs Postgres for the migrations job, so booting the app
against it and asserting no GET route returns 500 is perhaps forty lines. It
covers three of the four bugs that have reached the user's screen. It does not
cover the fourth - `api.importJob`, where every route was fine and the browser
could not read them - which is the argument for the second half.

The web half is about 8,000 lines with no tests at all, and it is where every
bug a user has actually seen has come from.
