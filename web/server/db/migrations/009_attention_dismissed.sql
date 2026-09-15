-- "I know, and it is fine." One flag, per user, per track.
--
-- The Overview flags every track whose metadata could not be resolved, because
-- those reach the iPod with the artist and album blank and that is worth
-- knowing. But some of them are never going to resolve - a live set nobody
-- catalogued, a regional upload, a recording that exists on YouTube and nowhere
-- else - and a warning that cannot be acted on is a warning people learn to
-- ignore, along with the ones that could have been acted on.
--
-- So this is not "hide the track" and not "pretend it resolved". The track still
-- syncs exactly as it did, still shows as unresolved in the Songs list, and the
-- flag can be lifted again. It only stops the counting.
--
-- On library_tracks rather than tracks, because it is a judgement one person
-- made about their own library. Two users can share a catalogue row and
-- disagree about whether it needs their attention.
ALTER TABLE library_tracks
  ADD COLUMN IF NOT EXISTS attention_dismissed BOOLEAN NOT NULL DEFAULT false;

-- The count on the Overview is the only hot read of this, and it is always
-- filtered by user first, so a partial index on the dismissed rows is enough.
-- Most libraries will have none at all.
CREATE INDEX IF NOT EXISTS library_tracks_attention_idx
  ON library_tracks (user_id)
  WHERE attention_dismissed;
