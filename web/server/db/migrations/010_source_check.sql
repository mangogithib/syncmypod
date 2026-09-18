-- What the local app found when it went looking for a track's audio.
--
-- Without this the only way to learn that a song could not be found is to run
-- a whole sync with the iPod plugged in and read the failures afterwards. The
-- local app can answer the same question in seconds per track without
-- downloading anything - it already has the search, the scoring and the
-- duration check - so it does that on demand and reports back here.
--
-- **Why the check stays in the local app.** Searching from this server would be
-- the obvious place for it, and it does not work: one large sync is enough to
-- get a home connection blocked, with every search returning
-- "Sign in to confirm you're not a bot". A datacentre address is the primary
-- target of that check and would be blocked harder and permanently, and the only
-- known fix is a signed-in session - which would mean a Google credential on a
-- public box. So the searching happens on the user's own machine, from their own
-- address, and only the answer is stored here.
--
-- On library_tracks because it is per user: the URL that satisfies one person's
-- copy of a track is theirs, and so is the fact that nothing was found.
ALTER TABLE library_tracks
  ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ,
  -- The last check looked and found nothing usable. Distinct from
  -- source_checked_at being null, which means nobody has looked yet, and from a
  -- set source_hint, which means it was found or was pasted by hand.
  ADD COLUMN IF NOT EXISTS source_missing BOOLEAN NOT NULL DEFAULT false;

-- The Overview counts these, always filtered by user first.
CREATE INDEX IF NOT EXISTS library_tracks_source_missing_idx
  ON library_tracks (user_id)
  WHERE source_missing;
