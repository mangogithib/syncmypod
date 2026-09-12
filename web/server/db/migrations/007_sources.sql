-- Standing sources: a playlist somewhere else that this library follows.
--
-- The difference from an import is that an import happens once. Paste a
-- playlist link on the Import page and you get its tracks as they were that
-- afternoon; a song added to it next week never arrives. A source is the same
-- link, remembered, and re-read whenever the app is opened - so the playlist
-- someone actually maintains stays the thing the iPod holds.
--
-- Deliberately additive only. A track removed from the playlist upstream is NOT
-- removed here, for the same reason the local app never deletes a track it did
-- not add: the cost of being wrong is somebody's music, and "it vanished from
-- my library" is a much worse failure than "it is still there".

CREATE TABLE watched_sources (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Which reader handles it. Kept as text rather than an enum so adding a
  -- provider is a code change and not a migration.
  kind               TEXT NOT NULL,
  -- The provider's own id, normalised on the way in, so the same playlist
  -- pasted as three different URL shapes is one source.
  ref                TEXT NOT NULL,
  name               TEXT NOT NULL,
  artwork_url        TEXT,

  -- Where its tracks land. Created on the first check and kept, so the playlist
  -- here keeps its identity even if it is renamed upstream.
  target_playlist_id BIGINT REFERENCES playlists(id) ON DELETE SET NULL,

  -- Off means "remembered but not followed". Removing a source is the other
  -- option, and deliberately does not touch anything already imported.
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,

  last_checked_at    TIMESTAMPTZ,
  last_added         INTEGER NOT NULL DEFAULT 0,
  last_seen_count    INTEGER,
  -- Shown next to the source rather than thrown. A playlist that has been made
  -- private should say so where the user can see it and act.
  last_error         TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One row per playlist per user. Pasting the same link twice updates rather
  -- than duplicating.
  UNIQUE (user_id, kind, ref)
);

CREATE INDEX watched_sources_due_idx
  ON watched_sources (user_id, last_checked_at) WHERE enabled;

-- Columns from 006 that no longer have a consumer.
--
-- They existed for a library pushed up by the local app. That path is gone: the
-- local app's YouTube sign-in is a borrowed account kept for downloading, and
-- reading its playlists would be reading somebody else's library. Leaving dead
-- columns behind is how a schema becomes unreadable.
DROP INDEX IF EXISTS youtube_playlists_user_source_idx;
ALTER TABLE youtube_playlists DROP COLUMN IF EXISTS source;
ALTER TABLE youtube_playlists DROP COLUMN IF EXISTS pushed_at;
