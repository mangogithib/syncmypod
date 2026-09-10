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
| `10.x.x.x` | A private network address — that network only |
| `0.0.0.0` | Every interface. **Only do this behind HTTPS.** |

Pairing codes and device tokens travel over the network. Over plain HTTP they are
readable in transit, so put TLS in front before exposing this to the internet.
There is a bundled way to do that — see below.

### Publishing it over HTTPS on your own domain

An optional Compose profile adds a Caddy reverse proxy that terminates TLS with a
real Let's Encrypt certificate. It is off by default, because "reachable from the
internet" should be a deliberate switch.

The unusual part: it obtains certificates via the **DNS-01** challenge rather
than the usual HTTP-01. HTTP-01 needs inbound port 80 and TLS-ALPN-01 needs 443;
DNS-01 needs no inbound port at all. That makes this work on a host where 80 and
443 are already taken by something else, and it means the certificate can be
issued before any port is opened. It currently ships with the DuckDNS provider
compiled in (`caddy/Dockerfile`); swapping in another DNS host is a one-line
change to the `xcaddy build` line plus the `acme_dns` directive.

In `.env`:

```bash
PUBLIC_HOSTNAME=pod.example.org     # bare hostname, no scheme or port
PUBLIC_PORT=8444                    # must be open inbound
DUCKDNS_TOKEN=...                   # from duckdns.org, for the DNS-01 challenge
ACME_EMAIL=you@example.com          # required: renewal-failure warnings go here
PUBLIC_URL=https://pod.example.org:8444
TRUST_PROXY=172.16.0.0/12           # trust the bundled proxy, and only it
```

Then:

```bash
docker compose --profile public up -d --build
```

Three things to get right:

1. **Open the port in both places.** A host firewall rule is not enough on a
   cloud VM — the provider's own security rules (AWS security group, OCI security
   list, GCP firewall) drop the traffic first. Check both.
2. **`TRUST_PROXY` should be a CIDR, not `1`.** The app stays published on
   `BIND_ADDR` for local access, so it has two paths in. A hop count would
   make the app believe `X-Forwarded-For` on the direct path too, letting any
   client rotate its apparent IP and walk past the login rate limiter. A CIDR
   covering only the proxy is honoured when the peer really is the proxy.
3. **Leave `HSTS_MAX_AGE=0` until the certificate works**, then set it to
   `31536000`. HSTS is a promise the browser remembers, and there is no quick
   undo if you enable it on a host that cannot serve HTTPS.

Caddy refuses to start if `PUBLIC_HOSTNAME`, `DUCKDNS_TOKEN` or `ACME_EMAIL` is
missing, or if the hostname has a scheme or port in it. That check is in the
container entrypoint rather than in Compose, because Compose interpolates
variables for every service even when its profile is inactive — a required
variable in the compose file would break the ordinary non-public deployment.

---

## Configuring metadata providers

The app runs without either of these, but search and resolution will fail until
at least one is set.

**Configure them on the Settings page**, not in `.env`. Changes take effect on
the next request with no restart, and each provider has a **Test connection**
button that makes one real request and reports what came back — "configured" and
"working" are different things, and the gap between them is where the
frustrating failures live.

The environment variables still work and **take precedence** when set, for
deployments that prefer declarative config. A value owned by the environment
shows in the UI as locked, naming the variable, rather than accepting an edit
and appearing to lose it.

### Spotify

Spotify's catalogue separates featured artists into distinct, ordered fields and
has clean artwork and track numbers. Raw YouTube Music and SoundCloud metadata
routinely collapse several artists into one string, or amount to little more than
a video title — which is why resolution goes through a real catalogue first.

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
2. Paste the Client ID and Client Secret into Settings. That alone enables search
   and metadata resolution.
3. To also import your own playlists, register a Redirect URI on the Spotify app
   matching the one Settings displays — normally
   `<PUBLIC_URL>/api/import/spotify/callback`.

Two Spotify-side requirements that have nothing to do with your credentials
being correct, and which the Test connection button will tell you about:

- **The account that owns the app must have an active Spotify Premium
  subscription.** Without it every Web API call returns
  `403 Active premium subscription required for the owner of the app`, even
  though the token endpoint authenticates fine. Spotify notes that a change in
  subscription status can take a few hours to take effect.
- An app in **development mode** can only authorise users explicitly added to
  it, so add your own account there before linking.

### MusicBrainz

MusicBrainz requires every client to identify itself with a contactable address
and throttles clients that do not. Rather than send a fake one, the app treats a
missing contact as "provider unavailable". Requests are serialised to roughly one
per second, as their guidelines ask.

Be aware of what it is and is not good at. Coverage of Western catalogue is
strong, but it has no popularity signal, so a title-only search cannot tell an
original from a cover, and it models every live performance as its own
recording — meaning a well-known song returns the studio take buried among
bootlegs. The app compensates by scoring release quality (official vs bootleg,
studio vs live) and ranking on it, but coverage of film and regional music is
genuinely thin. It is a fallback, not a substitute for a primary provider.

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
