import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import { many } from '../db/pool.js';
import { handler, str } from '../lib/api.js';
import * as deezer from '../providers/deezer.js';

export const suggestRoutes = Router();
suggestRoutes.use(requireUser);

// Name suggestions while somebody types metadata in by hand.
//
// Two sources, in this order and never mixed:
//
//   * what is already in this library, so a second Arijit Singh track is
//     credited to the same artist row rather than to a near-duplicate that
//     differs by a space; then
//   * what Deezer knows, so a name the library has not seen yet still arrives
//     spelled the way the catalogue spells it.
//
// The library comes first because it is the one that prevents a mess. Every
// slightly different spelling of a name becomes its own artist on the Artists
// page, and nothing merges them afterwards.

const LOCAL_LIMIT = 3;
const GLOBAL_LIMIT = 6;

// Below this there is nothing to go on and every query matches, so the lookup
// is not worth making.
const MIN_LENGTH = 2;

suggestRoutes.get(
  '/artists',
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < MIN_LENGTH) return res.json({ local: [], global: [] });

    const local = await many(
      `SELECT DISTINCT a.name, a.image_url AS "imageUrl"
         FROM artists a
         JOIN track_artists ta ON ta.artist_id = a.id
         JOIN library_tracks lt ON lt.track_id = ta.track_id
        WHERE lt.user_id = $1 AND a.name ILIKE $2
     ORDER BY a.name
        LIMIT $3`,
      [req.user.id, `%${q}%`, LOCAL_LIMIT]
    );

    res.json({ local, global: await globalArtists(q, local) });
  })
);

suggestRoutes.get(
  '/albums',
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < MIN_LENGTH) return res.json({ local: [], global: [] });

    const local = await many(
      `SELECT DISTINCT al.name, al.artwork_url AS "imageUrl",
              aa.name AS "subtitle"
         FROM albums al
         JOIN tracks t ON t.album_id = al.id
         JOIN library_tracks lt ON lt.track_id = t.id
    LEFT JOIN artists aa ON aa.id = al.album_artist_id
        WHERE lt.user_id = $1 AND al.name ILIKE $2
     ORDER BY al.name
        LIMIT $3`,
      [req.user.id, `%${q}%`, LOCAL_LIMIT]
    );

    let global = [];
    if (deezer.isEnabled()) {
      try {
        const found = await deezer.searchAll(q, { types: 'album', limit: GLOBAL_LIMIT });
        global = dropDuplicates(
          (found?.albums || []).map((album) => ({
            name: album.name,
            imageUrl: album.artworkUrl || null,
            subtitle: album.artists?.[0]?.name || null,
          })),
          local
        );
      } catch {
        // A suggestion list is a convenience. Deezer being slow or unreachable
        // must not stop somebody typing a name in themselves.
      }
    }

    res.json({ local, global });
  })
);

async function globalArtists(q, local) {
  if (!deezer.isEnabled()) return [];
  try {
    const found = await deezer.searchAll(q, { types: 'artist', limit: GLOBAL_LIMIT });
    return dropDuplicates(
      (found?.artists || []).map((artist) => ({
        name: artist.name,
        imageUrl: artist.imageUrl || null,
        subtitle: artist.fans ? `${artist.fans.toLocaleString('en-GB')} listeners` : null,
      })),
      local
    );
  } catch {
    return [];
  }
}

// A name already offered from the library is not offered again from Deezer.
// Seeing "Arijit Singh" twice in one dropdown, once under each heading, invites
// the user to wonder which one is different.
function dropDuplicates(candidates, local) {
  const seen = new Set(local.map((entry) => entry.name.toLowerCase().trim()));
  return candidates.filter((entry) => {
    const key = entry.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
