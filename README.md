# SyncMyPod

A self-hosted music library manager for classic and clickwheel iPods.

Manage your catalogue, playlists and followed artists from any browser. A small
local app — running only on the computer the iPod is plugged into — does the
actual downloading and syncing.

**This server never stores audio.** It holds library data only: track, album and
artist metadata, playlists, import history, followed artists. There is no column
anywhere in the schema for an audio file. That keeps the server light, means it
hosts no media, and keeps all downloading on the machine that owns the iPod.

---

## Why the split

Browsers cannot see USB devices, so a pure web app has no way to detect an iPod
or write to it. And the person curating a library on their phone is often not
sitting at the computer with the iPod attached. So the two jobs are separate:

| | Web tool (this repo) | Local app |
|---|---|---|
| Runs | On your server, always | On the computer with the iPod |
| Holds | Library data | Nothing permanently |
| Touches audio | Never | Downloads, tags, writes, then deletes |
| Reachable from | Any browser | The one machine |

---

## What works today

- **Library management** — songs, albums, artists, with search, filtering,
  sorting and paging.
- **Metadata resolution** — Spotify first, MusicBrainz as fallback. ISRC lookup,
  then scored search, then a loose title-only pass.
- **Manual correction** — edit any track; it is then marked `manual` and
  automatic resolution will not overwrite it.
- **Playlists** — create, edit, reorder (drag or keyboard), and choose per
  playlist whether it syncs to the device.
- **Spotify import** — link your account, import playlists or Liked Songs.
  Imports run server-side and survive a closed browser.
- **Followed artists** — mark an artist and new releases are added
  automatically. Following records a baseline first, so your back catalogue is
  never pulled in.
- **Device pairing** — pair a computer with a short code; it receives a
  long-lived token. Your password is never stored on that machine, and any token
  can be revoked independently.
- **Sync API** — the manifest, run tracking and per-track result reporting that
  the local app talks to. See [docs/LOCAL_APP_API.md](docs/LOCAL_APP_API.md).

### Not built yet

The local sync app itself. The API it talks to is live and testable — you can
pair a computer against it today.

---

## Deploying

Requires Docker and Docker Compose. Nothing else.

```bash
git clone <this repo> syncmypod
cd syncmypod
cp .env.example .env
```

Edit `.env`. Two values are required and the app refuses to start without them:

```bash
# Generate each with: openssl rand -hex 24
DB_PASSWORD=...
SESSION_SECRET=...
```

Then:

```bash
docker compose up -d --build
```

Open the address in `BIND_ADDR`/`HOST_PORT` and the first-run screen will ask you
to create the owner account. That screen is available only while the instance has
no accounts; after that it becomes a sign-in form.

### Who can reach it

`BIND_ADDR` decides this, and the default is deliberately the safe answer:

| Value | Reachable from |
|---|---|
| `127.0.0.1` (default) | The server itself only |
| `100.x.x.x` | A Tailscale/VPN address — that network only |
| `0.0.0.0` | Every interface. **Only do this behind HTTPS.** |

Pairing codes and device tokens travel over the network. Over plain HTTP they are
readable in transit, so put a TLS terminator (Caddy, nginx, Cloudflare Tunnel) in
front before exposing this to the internet, and set `TRUST_PROXY=1` when you do —
otherwise `req.ip` is the proxy's address and the rate limiter cannot tell clients
apart.

---

## Configuring metadata providers

The app runs without either of these, but search and resolution will fail until
at least one is set. The Settings page reports which are active.

### Spotify (recommended)

Spotify's catalogue separates featured artists into distinct, ordered fields and
has clean artwork and track numbers. Raw YouTube Music and SoundCloud metadata
routinely collapse several artists into one string, or amount to little more than
a video title — which is why resolution goes through a real catalogue first.

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
2. Put the Client ID and Client Secret in `.env`:
   ```bash
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```
   That alone enables search and metadata resolution.
3. To also import your own playlists, register a Redirect URI on the Spotify app
   that matches `SPOTIFY_REDIRECT_URI` exactly — normally
   `<PUBLIC_URL>/api/import/spotify/callback`. Settings shows the exact string to
   paste.
4. `docker compose up -d` to pick up the change.

Note that a Spotify app in development mode can only authorise users you have
explicitly added to it, so add your own account there before linking.

### MusicBrainz (fallback)

MusicBrainz requires every client to identify itself with a contactable address
and throttles clients that do not. Rather than send a fake one, the app treats a
missing contact as "provider unavailable":

```bash
MUSICBRAINZ_CONTACT=you@example.com
```

Requests are serialised to roughly one per second, as their guidelines ask.

---

## Operating it

```bash
# Logs
docker compose logs -f app

# Create an account, or reset a forgotten password
docker compose exec app npm run create-user -- <username> [password]

# Back up. Everything is in Postgres, so this is a complete backup.
docker compose exec -T db pg_dump -U syncmypod syncmypod > backup.sql

# Update
git pull && docker compose up -d --build
```

Migrations run automatically at startup. They are applied in filename order,
each in its own transaction, each recorded so it never runs twice.

---

## How resolution works

Whatever a track claims to be, it is re-resolved against a real catalogue before
anything is written to an iPod. A download source's own title is never trusted.

Three tiers, strongest first:

1. **ISRC lookup.** An exact identifier for a specific recording. A hit needs no
   confirmation.
2. **Structured search** on title, artist and album, with each candidate scored
   on title similarity (50%), artist (30%), duration (12%) and album (8%). The
   bar for acceptance is 0.62 — enough to accept a right-title/right-artist match
   with no duration to check, and to reject a right-title/wrong-artist one.
3. **Loose title-only search**, for the case where the source metadata was so
   poor that the artist was embedded in the title
   (`Artist - Title (Official Video)`).

Anything that clears the bar is stored as `resolved`. Anything below it is stored
as `unresolved`, with the best near-miss kept so the UI can offer it as a
suggestion. **Unresolved tracks are excluded from the sync manifest** — they show
in the library, flagged, and the manifest reports them separately.

`metadata_state` is the gate:

| State | Meaning | Syncs? |
|---|---|---|
| `pending` | Never resolved | No |
| `unresolved` | Resolution ran, found nothing good enough | No |
| `resolved` | Matched to a provider record | Yes |
| `manual` | A human corrected it; the resolver leaves it alone | Yes |

---

## Layout

```
server/
  config.js            Every env var, validated at boot
  db/                  Pool, migration runner, schema
  auth/                Passwords (scrypt), sessions, device tokens
  providers/           Spotify and MusicBrainz clients
  services/            Resolver, library queries, imports, follows, manifest
  routes/              HTTP layer
public/                Frontend: vanilla ES modules, no build step
docs/                  The local app API contract
```

The frontend has no bundler and two npm dependencies exist server-side
(`express`, `pg`). Nothing native, so the image builds as fast on arm64 as on
amd64.

Colours, spacing and radii are all tokens in
[public/css/theme.css](public/css/theme.css); nothing is hard-coded elsewhere, so
re-theming is one file.

---

## Security notes

- Passwords are hashed with scrypt (N=2^15), from Node's own crypto — no native
  dependency.
- Sessions are server-side rows, so revocation is one `DELETE`. The cookie is
  `HttpOnly`, `SameSite=Lax`, and `Secure` only when the connection actually is
  HTTPS (setting it otherwise makes the browser silently drop it).
- Device tokens are stored as SHA-256 hashes and shown exactly once. Changing
  your password logs out every browser session but deliberately does **not**
  revoke device tokens — the two are independent, so a password change need not
  break a working sync on another machine.
- Login, setup, pairing and provider search are rate limited per IP or per user.
- The frontend builds every node through `textContent`, so nothing from a
  provider API or a text field can be interpreted as markup.
- CSP is strict (`script-src 'self'`, no inline scripts). `img-src` allows
  `https:` because album artwork loads from provider CDNs.

---

## Legal

Downloading audio from streaming platforms generally breaches their terms of
service. This design keeps that entirely within each user's own instance and own
machine — no audio passes through this server — but it does not make it someone
else's problem. Run your own instance and make your own call.
