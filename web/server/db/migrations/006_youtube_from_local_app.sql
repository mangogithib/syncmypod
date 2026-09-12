-- A YouTube library can now arrive two ways, and the difference matters.
--
-- Migration 005 assumed one route: an OAuth grant held by this server, refreshed
-- by this server whenever the app is opened. That works, but it costs the
-- instance owner a trip through the Google Cloud console before the login button
-- they wanted exists at all - create a project, enable an API, register a
-- client, add a redirect URI, add yourself as a test user. For a self-hosted
-- tool with one user that is a great deal of ceremony for a small feature, and
-- Mohamed said so.
--
-- The second route needs none of it. The local app already signs in to YouTube
-- to fetch higher-quality audio, and that same session can list the account's
-- playlists. So the local app reads the library and pushes it here.
--
-- The trade is real and worth recording: no credential ever reaches this server,
-- which is the security win, but this server therefore cannot refresh the
-- library by itself. A local-app library is as current as the last time the
-- local app ran.

ALTER TABLE youtube_playlists
  ADD COLUMN source TEXT NOT NULL DEFAULT 'oauth';

COMMENT ON COLUMN youtube_playlists.source IS
  'oauth = read by this server with a stored grant; local-app = pushed by the '
  'paired local app using its own YouTube session. Decides which UI is shown '
  'and whether this server can refresh the list on its own.';

-- When the local app last pushed a library, so the UI can say how current the
-- list is rather than implying it is live.
ALTER TABLE youtube_playlists
  ADD COLUMN pushed_at TIMESTAMPTZ;

-- A user can have a library from the local app without ever having connected an
-- OAuth account, so the presence of a youtube_accounts row can no longer be the
-- test for "is there anything to show". This index is what the state endpoint
-- uses instead.
CREATE INDEX youtube_playlists_user_source_idx
  ON youtube_playlists (user_id, source);
