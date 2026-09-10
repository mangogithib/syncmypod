-- Identity columns for two additional metadata providers: Deezer and iTunes.
--
-- Explicit columns rather than a generic external_ids JSONB blob, to match how
-- spotify_id and mbid are already handled and to keep the partial unique-ish
-- indexes below meaningful. Four providers is a known, small set; a schemaless
-- bag would buy flexibility nobody has asked for and lose the indexes.

ALTER TABLE artists ADD COLUMN deezer_id TEXT;
ALTER TABLE artists ADD COLUMN itunes_id TEXT;
ALTER TABLE albums  ADD COLUMN deezer_id TEXT;
ALTER TABLE albums  ADD COLUMN itunes_id TEXT;
ALTER TABLE tracks  ADD COLUMN deezer_id TEXT;
ALTER TABLE tracks  ADD COLUMN itunes_id TEXT;

CREATE INDEX artists_deezer_idx ON artists (deezer_id) WHERE deezer_id IS NOT NULL;
CREATE INDEX artists_itunes_idx ON artists (itunes_id) WHERE itunes_id IS NOT NULL;
CREATE INDEX albums_deezer_idx  ON albums  (deezer_id) WHERE deezer_id IS NOT NULL;
CREATE INDEX albums_itunes_idx  ON albums  (itunes_id) WHERE itunes_id IS NOT NULL;
CREATE INDEX tracks_deezer_idx  ON tracks  (deezer_id) WHERE deezer_id IS NOT NULL;
CREATE INDEX tracks_itunes_idx  ON tracks  (itunes_id) WHERE itunes_id IS NOT NULL;

-- Why the track match key changes with this migration
-- ---------------------------------------------------
-- With one provider, keying a track on that provider's id was enough. With four
-- it is actively wrong: the same recording found via Deezer and later via
-- Spotify would key as dz:123 and sp:abc and become two rows in the catalogue,
-- and therefore two entries on the iPod.
--
-- The ISRC is the one identifier that survives crossing between services, so
-- from here on it is the preferred track key and a provider id is only the
-- fallback. See matchKey() in server/lib/normalise.js.
--
-- Rows written before this migration keep whatever key they were created with.
-- That is deliberate: rewriting keys in place could collide with an existing row
-- and there is no safe automatic merge. In practice the affected set is whatever
-- was resolved before this ran, and the duplicate only appears if the same track
-- is later re-resolved through a different provider. The report below names any
-- such rows so they can be checked by hand.
DO $$
DECLARE
  affected INT;
BEGIN
  SELECT count(*) INTO affected
    FROM tracks
   WHERE isrc IS NOT NULL AND match_key NOT LIKE 'isrc:%';

  IF affected > 0 THEN
    RAISE NOTICE 'tracks with an ISRC but an older-style match_key: %. These may duplicate if re-resolved via a different provider.', affected;
  END IF;
END $$;
