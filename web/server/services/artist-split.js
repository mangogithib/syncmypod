import { many, one, query, transaction } from '../db/pool.js';
import { matchKey } from '../lib/normalise.js';
import * as deezer from '../providers/deezer.js';

// Turning "Pritam & Soham" into two artists, without turning "Earth, Wind &
// Fire" into three.
//
// iTunes reports every credited artist as one string - "Kailash Kher, Naresh
// Kamath & Paresh Kamath" - and gives no structured list. Deezer does give one,
// which is why it is tried first and why most tracks come out with proper
// separate artists. A track that only iTunes knew gets a single artist row
// naming several people, and the Artists page then lists a person who does not
// exist.
//
// The obvious fix is to split on "&" and ",". The obvious fix is wrong, and the
// counter-example is already in this library: **Earth, Wind & Fire** is one
// band. So are Simon & Garfunkel, Hall & Oates, Crosby, Stills, Nash & Young,
// Florence + the Machine. Splitting those invents members who never existed,
// silently and permanently.
//
// So nothing is split on the strength of punctuation. Every split is checked
// against Deezer, which has real artist entities and follower counts:
//
//   1. Look up the whole name, and every part.
//   2. If the whole name is at least as followed as its biggest part, it is a
//      band and is left alone. See the note on that comparison in classify() -
//      "does the whole name exist" is not enough, because Deezer files
//      collaborations as artists too.
//   3. Otherwise split, but only when every part checks out as a real artist.
//
// That turns a guess into a question with an answer. The cost is a couple of
// lookups per combined name, paid once per artist rather than once per track.

// Separators, longest first so "feat." is not left behind by a comma split.
//
// Deliberately NOT including "+" or "x": "Florence + the Machine" and
// "Charli xcx" are names, and the whole-name guard would have to catch them
// every time. The three below cover what iTunes actually produces.
const SEPARATORS = /\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/gi;

export function looksCombined(name) {
  return /(?:,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)/i.test(String(name || ''));
}

// The candidate parts, before anything has been checked.
export function splitCredit(name) {
  return String(name || '')
    .split(SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);
}

// Punctuation becomes a space rather than vanishing.
//
// Removing it entirely looks tidier and is wrong: it makes "Soham" and "So Ham"
// the same string, and Deezer has both. That collision picked the wrong artist
// on the first run of this against a real library.
function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Does Deezer know an artist by this exact name?
//
// Exact after normalisation, not "close enough". A fuzzy match here is what
// would let "Simon" stand in for "Simon & Garfunkel" and wave a bad split
// through, so the comparison is deliberately strict.
async function lookup(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) return null;

  let found;
  try {
    found = await deezer.searchAll(trimmed, { types: 'artist', limit: 5 });
  } catch {
    // Deezer being unreachable must not be read as "this artist is not real".
    // The caller treats null as unknown and leaves the row alone.
    return null;
  }

  const wanted = normalise(trimmed);
  const matches = (found?.artists || []).filter((artist) => normalise(artist.name) === wanted);
  if (matches.length === 0) return null;

  // Deezer returns near-duplicates - an artist and a tribute act under the same
  // name - in no useful order. The one people actually mean is the one with the
  // audience.
  return matches.reduce((best, artist) => ((artist.fans || 0) > (best.fans || 0) ? artist : best));
}

// Decisions already made, so a 300-track import asks about each credit once.
//
// Bounded rather than unbounded: a long-running server importing many libraries
// should not accumulate every artist string it has ever seen.
const decisions = new Map();
const MAX_REMEMBERED = 500;

export async function classifyCached(name) {
  const key = String(name || '').trim().toLowerCase();
  if (decisions.has(key)) return decisions.get(key);

  const outcome = await classify(name);
  if (decisions.size >= MAX_REMEMBERED) decisions.clear();
  decisions.set(key, outcome);
  return outcome;
}

/**
 * Decides what a combined-looking credit actually is.
 *
 * Returns one of:
 *   { verdict: 'single', artist }  the whole string is a real artist
 *   { verdict: 'split', artists }  it is several, and they were checked
 *   { verdict: 'leave', reason }   not sure, so nothing is changed
 */
export async function classify(name) {
  if (!looksCombined(name)) return { verdict: 'leave', reason: 'no separator' };
  if (!deezer.isEnabled()) return { verdict: 'leave', reason: 'Deezer is switched off' };

  const parts = splitCredit(name);
  if (parts.length < 2) return { verdict: 'leave', reason: 'nothing to split into' };

  const whole = await lookup(name);

  // Check each part.
  const checked = [];
  for (const part of parts) {
    checked.push({ name: part, artist: await lookup(part) });
  }

  const verified = checked.filter((entry) => entry.artist);

  // The guard, and it cannot be "does the whole name exist" alone.
  //
  // Deezer files collaborations as artists too: "Alan Walker & Ava Max" is a
  // real entry, and so is "BUNT. & Malou". Existence therefore separates
  // nothing. What does separate them is the audience, and it is not a close
  // call in either direction:
  //
  //   Earth, Wind & Fire     1,264,655 fans   best part     1,759   x719
  //   Simon & Garfunkel      1,165,520 fans   best part     3,053   x382
  //   Alan Walker & Ava Max      1,996 fans   best part 4,052,443   /2030
  //   BUNT. & Malou                 12 fans   best part    13,979   /1165
  //
  // A band is what its audience follows; a collaboration is a footnote to two
  // artists who each have one of their own. So the whole name is treated as a
  // single artist only when it is at least as followed as its biggest part.
  //
  // The alternative rule - "the whole exists, so leave it" - splits nothing,
  // and "all the parts exist, so split" shatters Earth, Wind & Fire, because
  // Earth, Wind and Fire are each also artists. Both were tried.
  if (whole) {
    const biggestPart = Math.max(0, ...verified.map((entry) => entry.artist.fans || 0));
    if ((whole.fans || 0) >= biggestPart) return { verdict: 'single', artist: whole };
  }

  // 3. Every part has to check out.
  //
  // Strict on purpose. Splitting when only some parts are real leaves the rest
  // as invented artists, which is the exact failure this exists to prevent -
  // and a credit this cannot confirm is better left as it was, where it is
  // visibly one odd row rather than several plausible wrong ones.
  if (verified.length !== checked.length) {
    return {
      verdict: 'leave',
      reason: `could not confirm ${checked
        .filter((entry) => !entry.artist)
        .map((entry) => `"${entry.name}"`)
        .join(', ')}`,
    };
  }

  return { verdict: 'split', artists: verified.map((entry) => entry.artist) };
}

// ---------------------------------------------------------------------------
// Repairing what is already stored
// ---------------------------------------------------------------------------

// Every artist row that names more than one person and has no provider identity
// of its own.
//
// The `deezer_id IS NULL` condition is doing real work: an artist Deezer
// returned as a single entity has one, and those are exactly the rows that must
// never be touched. Earth, Wind & Fire is excluded by this clause before any
// lookup happens.
export async function combinedArtists() {
  return many(
    `SELECT id, name, itunes_id AS "itunesId"
       FROM artists
      WHERE name ~ '[&,]' AND deezer_id IS NULL AND mbid IS NULL
   ORDER BY name`
  );
}

export async function repairArtists({ dryRun = false, onProgress } = {}) {
  const candidates = await combinedArtists();
  const report = { examined: 0, split: 0, confirmedSingle: 0, left: 0, details: [] };

  for (const candidate of candidates) {
    report.examined++;
    const outcome = await classify(candidate.name);

    if (outcome.verdict === 'split') {
      report.split++;
      report.details.push({
        name: candidate.name,
        verdict: 'split',
        into: outcome.artists.map((artist) => artist.name),
      });
      if (!dryRun) await applySplit(candidate.id, outcome.artists);
    } else if (outcome.verdict === 'single') {
      report.confirmedSingle++;
      report.details.push({
        name: candidate.name,
        verdict: 'single',
        into: [outcome.artist.name],
      });
      // Worth recording even though nothing is split: the row now carries a
      // provider identity, so it is skipped outright next time and gains an
      // image on the Artists page.
      if (!dryRun) await adoptIdentity(candidate.id, outcome.artist);
    } else {
      report.left++;
      report.details.push({ name: candidate.name, verdict: 'leave', reason: outcome.reason });
    }

    onProgress?.(report);
  }

  return report;
}

// Replaces one combined artist with the real ones behind it.
//
// `artist_credit` on the track is deliberately untouched. That string is what
// gets written to the iPod's artist tag, and "Kailash Kher, Naresh Kamath &
// Paresh Kamath" is the correct tag - it is only the browse-by-artist structure
// that was wrong.
async function applySplit(oldArtistId, artists) {
  await transaction(async (tx) => {
    const tracks = await tx.query('SELECT track_id FROM track_artists WHERE artist_id = $1', [
      oldArtistId,
    ]);

    const newIds = [];
    for (const artist of artists) {
      const key = matchKey({ deezerId: artist.deezerId, name: artist.name });
      const { rows } = await tx.query(
        `INSERT INTO artists (match_key, name, deezer_id, image_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (match_key) DO UPDATE
            SET deezer_id = COALESCE(artists.deezer_id, EXCLUDED.deezer_id),
                image_url = COALESCE(artists.image_url, EXCLUDED.image_url)
         RETURNING id`,
        [key, artist.name, artist.deezerId || null, artist.imageUrl || null]
      );
      newIds.push(rows[0].id);
    }

    for (const { track_id: trackId } of tracks.rows) {
      for (const [position, artistId] of newIds.entries()) {
        await tx.query(
          `INSERT INTO track_artists (track_id, artist_id, position, role)
           VALUES ($1, $2, $3, 'primary')
           ON CONFLICT (track_id, artist_id, role) DO NOTHING`,
          [trackId, artistId, position]
        );
      }
    }

    // Albums credited to the combined row move to the primary artist.
    //
    // Not optional. `albums.album_artist_id` is ON DELETE SET NULL, so deleting
    // the row without this silently leaves the album with no artist at all -
    // which is what the first run of this did to seventeen albums before anyone
    // looked. An album has one album artist, so it gets the first of the names,
    // which is the convention every catalogue uses.
    await tx.query('UPDATE albums SET album_artist_id = $2 WHERE album_artist_id = $1', [
      oldArtistId,
      newIds[0],
    ]);

    // A follow of the combined name moves too, rather than being cascaded away.
    await tx.query(
      `INSERT INTO followed_artists (user_id, artist_id, followed_at, auto_add,
                                     include_singles, include_compilations,
                                     target_playlist_id)
       SELECT user_id, $2, followed_at, auto_add, include_singles,
              include_compilations, target_playlist_id
         FROM followed_artists WHERE artist_id = $1
       ON CONFLICT DO NOTHING`,
      [oldArtistId, newIds[0]]
    );

    // The combined row goes. It was never a real artist, and leaving it would
    // keep it on the Artists page beside the people it names.
    await tx.query('DELETE FROM artists WHERE id = $1', [oldArtistId]);
  });
}

// A real band whose name happens to contain a separator. Nothing changes except
// that it now has an identity, so this question is not asked about it again.
async function adoptIdentity(artistId, artist) {
  await query(
    `UPDATE artists
        SET deezer_id = COALESCE(deezer_id, $2),
            image_url = COALESCE(image_url, $3)
      WHERE id = $1`,
    [artistId, artist.deezerId || null, artist.imageUrl || null]
  );
}

export async function countCombined() {
  const row = await one(
    `SELECT count(*)::int AS n
       FROM artists
      WHERE name ~ '[&,]' AND deezer_id IS NULL AND mbid IS NULL`
  );
  return row?.n || 0;
}

// Expands a provider's single combined credit into the artists behind it.
//
// Called on the way in, so the repair pass above is for history rather than a
// thing that has to keep being run. Only fires where the problem comes from:
// one artist, a separator in the name, and no provider identity of its own -
// which is exactly what an iTunes credit string looks like and never what a
// Deezer contributor list looks like.
//
// Returns the list unchanged whenever anything is uncertain. Nothing here is
// worth guessing at.
export async function expandCredit(artists) {
  if (!Array.isArray(artists) || artists.length !== 1) return artists;

  const [only] = artists;
  if (!only?.name || only.deezerId || only.mbid) return artists;
  if (!looksCombined(only.name)) return artists;

  const outcome = await classifyCached(only.name);
  if (outcome.verdict !== 'split') return artists;

  return outcome.artists.map((artist, index) => ({
    provider: 'deezer',
    deezerId: artist.deezerId || null,
    name: artist.name,
    imageUrl: artist.imageUrl || null,
    position: index,
    role: index === 0 ? 'primary' : 'featured',
  }));
}

// Gives an album back an artist, by asking its own tracks.
//
// Only needed because the first version of applySplit above deleted a combined
// artist without moving the albums credited to it, and the foreign key is ON
// DELETE SET NULL rather than RESTRICT - so the loss was silent. Kept as a
// repair rather than quietly fixed, because an album with no artist is visible
// on the Albums page and somebody has to be able to put it right.
export async function repairOrphanedAlbums() {
  const { rowCount } = await query(
    `UPDATE albums al
        SET album_artist_id = primary_artist.artist_id
       FROM (
         SELECT DISTINCT ON (t.album_id) t.album_id, ta.artist_id
           FROM tracks t
           JOIN track_artists ta ON ta.track_id = t.id
          WHERE t.album_id IS NOT NULL
       ORDER BY t.album_id, ta.position, ta.artist_id
       ) AS primary_artist
      WHERE al.id = primary_artist.album_id
        AND al.album_artist_id IS NULL`
  );
  return rowCount;
}

export async function countOrphanedAlbums() {
  const row = await one('SELECT count(*)::int AS n FROM albums WHERE album_artist_id IS NULL');
  return row?.n || 0;
}
