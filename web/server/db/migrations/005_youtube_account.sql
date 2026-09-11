-- A YouTube account connected to the web app, and the playlists chosen from it.
--
-- Separate from the local app's YouTube sign-in, deliberately and completely.
-- They do different jobs and must not share a credential:
--
--   The local app signs in with the browser's own cookies, on the user's own
--   machine, to get the 256kbps audio stream a Premium account is entitled to.
--   That is a download credential. It never leaves the machine.
--
--   This one is an OAuth grant held by the server, scoped to reading playlists
--   and nothing else. It cannot download anything and it cannot post anything.
--   It exists so the library here can follow a library over there.
--
-- Keeping them apart means a server compromise cannot reach a download session,
-- and revoking either leaves the other working.

CREATE TABLE youtube_accounts (
  id              BIGSERIAL PRIMARY KEY,
  -- One account per user. Connecting a second replaces the first, which is the
  -- behaviour people expect from "connect account" and avoids the question of
  -- which of two accounts a sync belongs to.
  user_id         BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Who it is, for showing in the UI. Not used for anything else.
  channel_id      TEXT,
  channel_title   TEXT,

  -- The long-lived grant, encrypted at rest - see services/youtube-account.js.
  -- This is the credential: anything holding it can read the account's
  -- playlists until the user revokes it in their Google settings.
  refresh_token   TEXT NOT NULL,

  -- The short-lived one, cached so a burst of requests needs one refresh
  -- rather than one per call. Also encrypted; also disposable.
  access_token    TEXT,
  access_expires  TIMESTAMPTZ,

  -- What the user actually granted. Recorded because a grant made against an
  -- earlier version of this app may be missing a scope a later one needs, and
  -- the difference should be visible rather than surfacing as a 403.
  scopes          TEXT NOT NULL DEFAULT '',

  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ,
  last_error      TEXT
);

-- The playlists visible in that account, and which of them to follow.
--
-- Every playlist found is stored, not only the chosen ones, so the picker has
-- something to show without calling YouTube on every page load - and so a
-- playlist that disappears from the account is noticed rather than silently
-- dropped from the list.
CREATE TABLE youtube_playlists (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- YouTube's own id. 'LL' is the liked-videos list, which is where YouTube
  -- Music puts liked songs; the rest are ordinary playlist ids.
  youtube_id        TEXT NOT NULL,
  title             TEXT NOT NULL,
  item_count        INTEGER,
  thumbnail_url     TEXT,

  -- Whether to sync it. Off by default: connecting an account should show what
  -- is there, not start importing thousands of tracks unasked.
  selected          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Where its tracks land here. Created on first sync of that playlist.
  target_playlist_id BIGINT REFERENCES playlists(id) ON DELETE SET NULL,

  -- What was seen last time, so an unchanged playlist can be skipped instead of
  -- re-resolving every track in it.
  last_synced_at    TIMESTAMPTZ,
  last_item_count   INTEGER,

  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, youtube_id)
);

CREATE INDEX youtube_playlists_selected_idx
  ON youtube_playlists (user_id) WHERE selected;

-- The import job table gains a source value; no schema change is needed for it
-- because `source` is free text. Recorded here so the set of values is
-- discoverable from the migrations:
--
--   deezer-playlist | youtube-playlist | youtube-account | track-list
