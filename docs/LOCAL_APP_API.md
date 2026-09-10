# Device API — the contract for the local sync app

This is the interface between the web tool and the local app. It is the most
important boundary in the project, so it is written down before the local app
exists.

Everything here is authenticated by a **device bearer token**, never by a browser
session. The two paths are deliberately separate: a CSRF against the web UI
cannot reach a sync endpoint, and a leaked device token cannot change the account
password.

```
Authorization: Bearer smp_<token>
```

All request and response bodies are JSON.

---

## The one rule

**Re-tag from the manifest. Never from the download source.**

The manifest carries resolved metadata — title, artist credit, album, track
number, artwork. Whatever the audio source embedded in the file it handed you is
to be discarded and replaced with these fields. That is the entire reason this
architecture exists: raw YouTube Music and SoundCloud metadata routinely collapse
several artists into one field, or amount to little more than a video title.

The manifest states this explicitly in `conventions.retagFromManifest`.

---

## Pairing

Two ways in. Both return a token that is stored on the local machine from then
on; the password, if used, is never saved.

### Pairing code (preferred)

The user reads an eight-character code off the web UI. No credentials are typed
into a desktop app.

```http
POST /api/devices/claim
```
```json
{
  "code": "QMS43P2C",
  "deviceName": "Mo Studio PC",
  "platform": "windows",
  "appVersion": "0.1.0"
}
```
```json
{
  "token": "smp_...",
  "device": { "id": 2, "name": "Mo Studio PC" },
  "serverUrl": "https://pod.example.com"
}
```

Codes are single-use and expire in 10 minutes. The alphabet excludes `0`/`O` and
`1`/`I`. Whitespace and hyphens in the submitted code are ignored, and it is
case-insensitive, so accept whatever the user types.

Store `serverUrl` from the response rather than whatever the user typed — it is
the server's own canonical address.

### Credentials (fallback)

For headless setups where reading a code off a web page is awkward.

```http
POST /api/devices/token
```
```json
{ "username": "mo", "password": "...", "deviceName": "Headless box" }
```

Same response shape. Use the password once, keep only the token.

Both endpoints are rate limited to 10 requests per minute per IP.

---

## Startup

```http
GET /api/sync/hello
```
```json
{
  "ok": true,
  "manifestVersion": 1,
  "device": { "id": 2, "name": "Mo Studio PC" },
  "user": { "id": 1, "username": "mo" },
  "supportedManifestVersions": [1]
}
```

Call this first, every run. A revoked token surfaces here as a clean
`401 Token is not valid or has been revoked.` rather than as a confusing failure
halfway through a sync.

**Refuse to run if `manifestVersion` is not one you understand.** Misinterpreting
a field is worse than stopping.

---

## Reporting the iPod

```http
POST /api/sync/device
```
```json
{
  "ipodName": "Mo iPod",
  "ipodModel": "iPod Classic 160GB",
  "ipodGeneration": "classic-7g",
  "ipodSerial": "...",
  "ipodCapacityBytes": 160000000000,
  "ipodFreeBytes": 151000000000,
  "ipodNeedsHash": true,
  "platform": "windows",
  "appVersion": "0.1.0"
}
```

Every field is optional; `COALESCE` means omitting one leaves the stored value
alone. Send this as soon as a device is detected, so the web UI can show
"160GB Classic, 141GB free" without the local app being open.

`ipodGeneration` and `ipodNeedsHash` matter because the iTunesDB dialect differs:

| Generation | Database signature |
|---|---|
| Nano 1st–3rd gen, Video 5th gen | Not required |
| Classic 6th/7th gen | **Required** (`hash58` / `hash72`) |

Get that wrong on a Classic and the iPod boots to an empty library — the files
are there and the database is rejected. The server records what you report rather
than guessing.

---

## The manifest

```http
GET /api/sync/manifest
```

Everything that should be on this iPod.

```json
{
  "manifestVersion": 1,
  "generatedAt": "2026-09-10T19:59:42.123Z",
  "device": { "id": 2, "name": "Mo Studio PC", "ipodGeneration": "classic-7g" },
  "conventions": {
    "artistJoin": ", ",
    "retagFromManifest": true
  },
  "tracks": [
    {
      "id": 1,
      "title": "Second Sunrise",
      "artist": "Aurora Kane, Minor Waves",
      "album": "Longer Days",
      "albumArtist": "Aurora Kane",
      "trackNo": 4,
      "discNo": 1,
      "durationMs": 268000,
      "isrc": "AA6Q72000047",
      "genre": null,
      "explicit": false,
      "year": 2022,
      "totalTracks": 11,
      "artworkUrl": "https://i.scdn.co/image/...",
      "spotifyId": "...",
      "mbid": null,
      "rating": null,
      "sourceHint": null,
      "artists": [
        { "name": "Aurora Kane", "role": "primary", "position": 0 },
        { "name": "Minor Waves", "role": "featured", "position": 1 }
      ],
      "searchTerms": {
        "primary": "Aurora Kane, Minor Waves - Second Sunrise",
        "withAlbum": "Aurora Kane, Minor Waves Second Sunrise Longer Days",
        "isrc": "AA6Q72000047",
        "durationMs": 268000
      },
      "deviceState": "synced",
      "deviceSyncedAt": "2026-09-10T19:59:54.712Z",
      "deviceFormat": "m4a"
    }
  ],
  "playlists": [
    { "id": 1, "name": "Morning Drive", "description": null, "trackIds": [3, 2, 1] }
  ],
  "excluded": [
    { "id": 4, "title": "Halfway Down", "artist": "Minor Waves", "metadataState": "unresolved" }
  ],
  "counts": { "tracks": 1, "playlists": 1, "excluded": 1 }
}
```

Names, ids and the ISRC above are placeholders chosen to show the shape — in
particular the primary/featured ordering, which is the part raw source metadata
destroys.

### Notes on the fields

- **There is no download URL, by design.** `searchTerms` is what you search a
  source with. `sourceHint` is an optional URL the user pasted — a hint, not a
  stored file.
- **`artist` is the string to write to the tag.** `artists` is the structured
  truth, for populating a multi-value frame where the format supports one. The
  join convention is decided server-side so every paired computer tags
  identically.
- **`deviceState`** is what the server believes you already have. Use it to skip
  work instead of re-deriving the diff from filenames. `null` means never synced.
- **`playlists[].trackIds`** is already ordered and already filtered — entries
  whose track left the library or is unresolved are removed, so you never have to
  handle a dangling reference.
- **`excluded`** is informational: tracks in the library that cannot be synced
  because their metadata is not confirmed. Do not write them. Showing the count
  to the user is useful, since the fix is in the web UI.
- **`artworkUrl`** points at a provider CDN and may 404. Handle a missing image;
  do not fail the track over it.

---

## A sync run

### 1. Open the run

```http
POST /api/sync/runs
```
```json
{ "planned": 40, "toDownload": 12, "toRemove": 3 }
```
```json
{ "id": 7, "startedAt": "..." }
```

Any previous run still marked `running` for this device is closed as abandoned —
the local app only syncs one iPod at a time, so a leftover `running` row means
the last attempt crashed.

### 2. Report results as you go

```http
POST /api/sync/runs/7/results
```
```json
{
  "results": [
    {
      "trackId": 1,
      "state": "synced",
      "format": "m4a",
      "bitrate": 256,
      "fileSize": 8912345,
      "sourceUsed": "youtube-music"
    },
    { "trackId": 9, "state": "failed", "error": "No source found above 128kbps" },
    { "trackId": 4, "state": "removed" }
  ]
}
```

`state` is one of `synced`, `failed`, `skipped`, `removed`. Up to 500 per
request.

**Report incrementally, not only at the end.** A sync interrupted halfway still
records the tracks that landed, so the next run does not download them again.

`removed` deletes the server's record of that track being on the device. Only
send it for tracks you actually removed — if the user declined the removal
prompt, the records must stay.

### 3. Close the run

```http
POST /api/sync/runs/7/finish
```
```json
{
  "status": "done",
  "stats": { "synced": 12, "failed": 1, "removed": 3 },
  "message": "optional human-readable note"
}
```

`status` is `done`, `error` or `cancelled`. `stats` is merged into whatever was
recorded when the run opened.

---

## Checking state without the manifest

```http
GET /api/sync/state
```
```json
{
  "tracks": [
    { "trackId": 1, "state": "synced", "syncedAt": "...", "format": "m4a",
      "bitrate": 256, "fileSize": 8912345, "attempts": 1, "error": null }
  ],
  "count": 1
}
```

Cheaper than the manifest when all you need is the diff. `attempts` counts
retries, so a track that fails every time is distinguishable from a one-off.

---

## The intended sync flow

1. `GET /api/sync/hello` — confirm the token and the manifest version.
2. Detect the iPod; `POST /api/sync/device` with what you found.
3. `GET /api/sync/manifest`.
4. Diff against the iPod. Trust `deviceState` as a starting point but verify
   against the device — the server cannot see it and the user may have used
   iTunes in between.
5. `POST /api/sync/runs`.
6. For each missing track: download, **re-tag from the manifest**, write it,
   `POST .../results`.
7. Write the playlists from `playlists[].trackIds`, in that order.
8. Prompt before removing anything on the iPod that is no longer in the
   manifest. Report confirmed removals as `state: "removed"`.
9. `POST .../finish`.
10. **Delete every downloaded file.** Nothing downloaded outlives the sync.

---

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 401 | Token missing, invalid, or revoked | Stop; ask the user to pair again |
| 404 | Run or device not found | Stop; do not retry |
| 400 | Malformed request | A bug in the local app; log it |
| 413 | Body too large | Send fewer results per batch |
| 429 | Rate limited | Honour `Retry-After` |
| 502/503 | Provider or database unavailable | Retry with backoff |

Error bodies are `{ "error": "human-readable message" }`. The messages are
written to be shown to a user as-is.

---

## Version history

**Manifest version 1** — initial. If a field is added in a compatible way the
version stays; if the meaning of an existing field changes, the version is bumped
and old local apps should refuse to run against it.
