-- SyncMyPod initial schema.
--
-- Two ideas shape this file:
--
-- 1. The CATALOGUE is shared; the LIBRARY is per-user. artists/albums/tracks are
--    resolved facts about music that exist independently of who wants them, so
--    they are keyed by provider identity and deduplicated globally. What a given
--    user actually wants on their iPod lives in library_tracks / playlists.
--    A self-hosted instance usually has one user, but building it this way costs
--    almost nothing now and avoids a painful migration if that ever changes.
--
-- 2. NO AUDIO. There is no column anywhere for a file path, a byte, or a stream
--    URL of actual music. This database describes what SHOULD be on an iPod.
--    The local sync app is the only component that ever handles audio.

-- ---------------------------------------------------------------------------
-- Accounts and access
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  display_name  TEXT,
  -- The first account created owns the instance. Kept explicit so a future
  -- multi-user mode has something to hang admin rights off.
  is_owner      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
-- Usernames are compared case-insensitively but stored as typed.
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

-- Browser sessions. Stored server-side rather than as a self-contained JWT so
-- that "log out everywhere" and "revoke this session" are one DELETE.
CREATE TABLE sessions (
  id         TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- A "device" is one installation of the local sync app. It authenticates with a
-- long-lived bearer token, exchanged once for a username/password at pairing
-- time, so the password is never stored on the computer with the iPod attached.
--
-- Only the SHA-256 of the token is kept. The token itself is shown exactly once
-- at creation, for the same reason a password is hashed. token_prefix exists
-- purely so the UI can answer "which of my three computers is this?" without
-- needing the secret.
CREATE TABLE devices (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_prefix  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  last_seen_ip  TEXT,
  revoked_at    TIMESTAMPTZ,
  app_version   TEXT,
  platform      TEXT,
  -- Reported by the local app once it sees an iPod. The generation decides
  -- which iTunesDB dialect applies: 6th/7th gen Classics need a database
  -- signature (hash58/hash72) that a 5th gen Video does not, and getting that
  -- wrong means the iPod boots to an empty library. So the server records what
  -- the device told it rather than letting the local app guess twice.
  ipod_name       TEXT,
  ipod_model      TEXT,
  ipod_generation TEXT,
  ipod_serial     TEXT,
  ipod_capacity_bytes BIGINT,
  ipod_free_bytes     BIGINT,
  ipod_needs_hash     BOOLEAN
);
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- Short-lived codes for pairing a local app without typing a password into it.
-- The web UI shows a code; the local app posts it back and receives a token.
CREATE TABLE pairing_codes (
  code       TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  device_id  BIGINT      REFERENCES devices(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Catalogue: artists, albums, tracks
-- ---------------------------------------------------------------------------

-- match_key is how the catalogue deduplicates. It is the strongest identity the
-- resolver could establish, in order of preference:
--     sp:<spotify id>  >  mb:<musicbrainz id>  >  n:<normalised name>
-- A unique constraint on a plain provider id cannot do this job, because a
-- record may arrive with only one of the two ids, or with neither. Computing the
-- key in application code and constraining it here keeps "one row per real
-- artist" enforced by the database rather than by hope.

CREATE TABLE artists (
  id         BIGSERIAL   PRIMARY KEY,
  match_key  TEXT        NOT NULL UNIQUE,
  name       TEXT        NOT NULL,
  sort_name  TEXT,
  spotify_id TEXT,
  mbid       UUID,
  image_url  TEXT,
  genres     TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX artists_name_idx    ON artists (lower(name));
CREATE INDEX artists_spotify_idx ON artists (spotify_id) WHERE spotify_id IS NOT NULL;

CREATE TABLE albums (
  id              BIGSERIAL   PRIMARY KEY,
  match_key       TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  album_artist_id BIGINT      REFERENCES artists(id) ON DELETE SET NULL,
  spotify_id      TEXT,
  mbid            UUID,
  -- Spotify returns yyyy, yyyy-MM or yyyy-MM-dd depending on precision, so the
  -- raw string is kept as given and the year extracted for sorting/display.
  release_date    TEXT,
  release_year    INT,
  artwork_url     TEXT,
  total_tracks    INT,
  total_discs     INT,
  album_type      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX albums_name_idx   ON albums (lower(name));
CREATE INDEX albums_artist_idx ON albums (album_artist_id);

CREATE TABLE tracks (
  id           BIGSERIAL   PRIMARY KEY,
  match_key    TEXT        NOT NULL UNIQUE,
  title        TEXT        NOT NULL,
  album_id     BIGINT      REFERENCES albums(id) ON DELETE SET NULL,
  track_no     INT,
  disc_no      INT,
  duration_ms  INT,
  -- The ISRC is the one identifier that survives crossing between services, so
  -- it is the resolver preferred way to match a track found on one source
  -- against the canonical record on another.
  isrc         TEXT,
  spotify_id   TEXT,
  mbid         UUID,
  explicit     BOOLEAN,
  genre        TEXT,
  -- Denormalised "Artist A, Artist B" exactly as it should be written to the
  -- iPod tag. track_artists below holds the structured truth; this column is
  -- what gets burned into the file, so the convention is decided once, here,
  -- rather than independently by every consumer.
  artist_credit   TEXT      NOT NULL DEFAULT '',
  album_credit    TEXT,
  metadata_source TEXT,
  -- pending: never resolved. resolved: matched to a provider record.
  -- unresolved: resolution ran and found nothing good enough. manual: a human
  -- corrected it and the resolver must not overwrite it.
  metadata_state  TEXT      NOT NULL DEFAULT 'pending',
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracks_metadata_state_chk
    CHECK (metadata_state IN ('pending', 'resolved', 'unresolved', 'manual'))
);
CREATE INDEX tracks_album_idx   ON tracks (album_id);
CREATE INDEX tracks_isrc_idx    ON tracks (isrc) WHERE isrc IS NOT NULL;
CREATE INDEX tracks_spotify_idx ON tracks (spotify_id) WHERE spotify_id IS NOT NULL;
-- Free-text search over title + artists + album. Expression index rather than a
-- stored tsvector column: the expression is cheap and this keeps writes simple.
CREATE INDEX tracks_search_idx  ON tracks USING gin (to_tsvector('simple',
  title || ' ' || artist_credit || ' ' || coalesce(album_credit, '')));

-- Multiple and featured artists get their own rows rather than being collapsed
-- into one string. This is the specific failure mode the concept calls out in
-- raw YouTube Music / SoundCloud metadata, and the reason resolution goes
-- through a real catalogue first.
CREATE TABLE track_artists (
  track_id  BIGINT NOT NULL REFERENCES tracks(id)  ON DELETE CASCADE,
  artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  position  INT    NOT NULL DEFAULT 0,
  role      TEXT   NOT NULL DEFAULT 'primary',
  PRIMARY KEY (track_id, artist_id, role),
  CONSTRAINT track_artists_role_chk CHECK (role IN ('primary', 'featured', 'remixer'))
);
CREATE INDEX track_artists_artist_idx ON track_artists (artist_id);

-- ---------------------------------------------------------------------------
-- Library: what this user wants on their iPod
-- ---------------------------------------------------------------------------

CREATE TABLE library_tracks (
  user_id     BIGINT      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  track_id    BIGINT      NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How it got here, so an accidental bulk import can be identified and undone.
  added_via   TEXT        NOT NULL DEFAULT 'manual',
  -- An optional hint for the local app about where the audio might be found
  -- (e.g. a YouTube Music URL a user pasted). A hint, not a stored file.
  source_hint TEXT,
  rating      SMALLINT,
  PRIMARY KEY (user_id, track_id),
  CONSTRAINT library_tracks_rating_chk CHECK (rating IS NULL OR rating BETWEEN 0 AND 5)
);
CREATE INDEX library_tracks_added_idx ON library_tracks (user_id, added_at DESC);

CREATE TABLE playlists (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  source       TEXT        NOT NULL DEFAULT 'local',
  source_ref   TEXT,
  -- Not every playlist needs to exist on the device. Lets the web tool be a
  -- superset of the iPod without forcing a bigger sync.
  sync_to_ipod BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX playlists_user_name_key ON playlists (user_id, lower(name));

CREATE TABLE playlist_tracks (
  playlist_id BIGINT      NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    BIGINT      NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
  -- Sparse ordering (10, 20, 30...) so a single-item move is one UPDATE rather
  -- than a renumbering of the whole playlist.
  position    INT         NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX playlist_tracks_order_idx ON playlist_tracks (playlist_id, position);

CREATE TABLE followed_artists (
  user_id         BIGINT      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  artist_id       BIGINT      NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  followed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  -- Following an artist to watch their releases is not the same as wanting
  -- every one of them on a 160GB device, so auto-add is a per-artist decision.
  auto_add        BOOLEAN     NOT NULL DEFAULT TRUE,
  include_singles BOOLEAN     NOT NULL DEFAULT TRUE,
  include_compilations BOOLEAN NOT NULL DEFAULT FALSE,
  target_playlist_id BIGINT   REFERENCES playlists(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, artist_id)
);

-- Releases already seen for a followed artist. Without this, the first check
-- after following would treat the entire back catalogue as "new".
CREATE TABLE artist_release_seen (
  user_id     BIGINT      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  artist_id   BIGINT      NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  release_key TEXT        NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, artist_id, release_key)
);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

-- What the server believes is actually on each device. The local app is the
-- authority and reports back; the server only records. Keeping this per-device
-- rather than per-user is what makes two computers syncing the same account
-- work without fighting each other.
CREATE TABLE device_tracks (
  device_id   BIGINT      NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  track_id    BIGINT      NOT NULL REFERENCES tracks(id)  ON DELETE CASCADE,
  state       TEXT        NOT NULL,
  synced_at   TIMESTAMPTZ,
  file_size   BIGINT,
  bitrate     INT,
  format      TEXT,
  source_used TEXT,
  error       TEXT,
  attempts    INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, track_id),
  CONSTRAINT device_tracks_state_chk
    CHECK (state IN ('synced', 'failed', 'skipped', 'removed'))
);

CREATE TABLE sync_runs (
  id          BIGSERIAL   PRIMARY KEY,
  device_id   BIGINT      NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT        NOT NULL DEFAULT 'running',
  stats       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  message     TEXT,
  CONSTRAINT sync_runs_status_chk
    CHECK (status IN ('running', 'done', 'error', 'cancelled'))
);
CREATE INDEX sync_runs_device_idx ON sync_runs (device_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Imports and external accounts
-- ---------------------------------------------------------------------------

CREATE TABLE import_jobs (
  id                 BIGSERIAL   PRIMARY KEY,
  user_id            BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source             TEXT        NOT NULL,
  source_ref         TEXT,
  source_name        TEXT,
  status             TEXT        NOT NULL DEFAULT 'queued',
  total              INT         NOT NULL DEFAULT 0,
  processed          INT         NOT NULL DEFAULT 0,
  added              INT         NOT NULL DEFAULT 0,
  skipped            INT         NOT NULL DEFAULT 0,
  failed             INT         NOT NULL DEFAULT 0,
  target_playlist_id BIGINT      REFERENCES playlists(id) ON DELETE SET NULL,
  error              TEXT,
  -- Per-item outcomes, so "which 4 of my 300 tracks failed" is answerable.
  report             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT import_jobs_status_chk
    CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled'))
);
CREATE INDEX import_jobs_user_idx ON import_jobs (user_id, created_at DESC);

-- OAuth links to external services, currently only Spotify. Tokens live here
-- rather than in a session so an import can keep running after the browser
-- closes, and so the refresh token survives a logout.
CREATE TABLE oauth_accounts (
  user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL,
  provider_user_id TEXT,
  display_name     TEXT,
  access_token     TEXT,
  refresh_token    TEXT,
  expires_at       TIMESTAMPTZ,
  scopes           TEXT,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Provider responses, cached. Two reasons: MusicBrainz allows roughly one
-- request per second and will throttle a client that ignores that, and a
-- 300-track playlist import would otherwise re-request the same albums and
-- artists dozens of times.
CREATE TABLE provider_cache (
  cache_key  TEXT        PRIMARY KEY,
  provider   TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provider_cache_fetched_idx ON provider_cache (fetched_at);

CREATE TABLE settings (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT   NOT NULL,
  value   JSONB  NOT NULL,
  PRIMARY KEY (user_id, key)
);
