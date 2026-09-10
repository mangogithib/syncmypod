-- Removes Spotify entirely.
--
-- Spotify now refuses every Web API call unless the account that owns the
-- registered app holds an active Premium subscription. That makes it unusable
-- as a provider here regardless of whether the credentials are correct, and a
-- half-removed integration - dead columns, an OAuth table nothing writes to, a
-- Settings section that can only ever report failure - is worse than either
-- keeping it or removing it properly.
--
-- Deezer and iTunes cover the same ground and need no account at all.
--
-- This is a one-way door, deliberately. Re-adding Spotify later means a new
-- migration plus a provider module; the provider layer is pluggable, so that is
-- a contained piece of work rather than a rewrite. What is NOT worth carrying is
-- schema for an integration nobody can use.

-- Provider identity columns.
DROP INDEX IF EXISTS artists_spotify_idx;
DROP INDEX IF EXISTS albums_spotify_idx;
DROP INDEX IF EXISTS tracks_spotify_idx;

ALTER TABLE artists DROP COLUMN IF EXISTS spotify_id;
ALTER TABLE albums  DROP COLUMN IF EXISTS spotify_id;
ALTER TABLE tracks  DROP COLUMN IF EXISTS spotify_id;

-- The OAuth token store existed only to read a user's own Spotify playlists.
-- Nothing else ever wrote to it.
DROP TABLE IF EXISTS oauth_accounts;

-- Settings rows for credentials that no longer have a consumer. Left in place
-- they would keep appearing in the Settings API response.
DELETE FROM app_settings WHERE key LIKE 'spotify.%';

-- Any track whose only identity was a Spotify id now has none, so its match_key
-- can no longer be derived from the same inputs. Those rows are re-keyed to the
-- name-based fallback so a later re-resolution converges on them rather than
-- inserting a duplicate alongside.
--
-- Tracks keyed by ISRC, Deezer, iTunes or MusicBrainz id are untouched: their
-- identity is unaffected by Spotify going away.
UPDATE tracks
   SET match_key = 'n:' || lower(regexp_replace(title, '[^a-zA-Z0-9]+', ' ', 'g'))
                        || '|' || lower(regexp_replace(coalesce(artist_credit, ''),
                                                       '[^a-zA-Z0-9]+', ' ', 'g')),
       metadata_source = CASE WHEN metadata_source = 'spotify' THEN NULL
                             ELSE metadata_source END
 WHERE match_key LIKE 'sp:%'
   -- Skip any row whose new key would collide with an existing one; leaving the
   -- old key is harmless, whereas a failed unique constraint would abort the
   -- whole migration.
   AND NOT EXISTS (
     SELECT 1 FROM tracks other
      WHERE other.match_key =
              'n:' || lower(regexp_replace(tracks.title, '[^a-zA-Z0-9]+', ' ', 'g'))
                   || '|' || lower(regexp_replace(coalesce(tracks.artist_credit, ''),
                                                  '[^a-zA-Z0-9]+', ' ', 'g'))
   );

-- Same for artists and albums, which have no ISRC equivalent to fall back on.
UPDATE artists
   SET match_key = 'n:' || lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g'))
 WHERE match_key LIKE 'sp:%'
   AND NOT EXISTS (
     SELECT 1 FROM artists other
      WHERE other.match_key =
              'n:' || lower(regexp_replace(artists.name, '[^a-zA-Z0-9]+', ' ', 'g'))
   );

UPDATE albums
   SET match_key = 'n:' || lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g'))
 WHERE match_key LIKE 'sp:%'
   AND NOT EXISTS (
     SELECT 1 FROM albums other
      WHERE other.match_key =
              'n:' || lower(regexp_replace(albums.name, '[^a-zA-Z0-9]+', ' ', 'g'))
   );

-- Playlists that came from a Spotify import keep their tracks and their name;
-- only the provenance label changes, since the source they point at is gone and
-- re-importing from it is no longer possible.
UPDATE playlists
   SET source = 'local', source_ref = NULL
 WHERE source = 'spotify';

-- Import history for a source that no longer exists.
DELETE FROM import_jobs WHERE source LIKE 'spotify%';

-- Cached Spotify API responses.
DELETE FROM provider_cache WHERE provider = 'spotify';

DO $$
DECLARE
  orphaned INT;
BEGIN
  SELECT count(*) INTO orphaned FROM tracks WHERE match_key LIKE 'sp:%';
  IF orphaned > 0 THEN
    RAISE NOTICE 'tracks still keyed on a Spotify id (re-key would have collided): %. Harmless, but they may duplicate if re-resolved.', orphaned;
  END IF;
END $$;
