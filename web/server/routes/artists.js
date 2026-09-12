import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { many, one, query } from '../db/pool.js';
import { bool, handler, id, notFound, str } from '../lib/api.js';
import { matchKey } from '../lib/normalise.js';
import * as deezer from '../providers/deezer.js';
import { countCombined, repairArtists } from '../services/artist-split.js';
import { checkFollowedArtist } from '../services/follows.js';

export const artistRoutes = Router();
artistRoutes.use(requireUser);

// Followed artists: mark an artist and their new releases arrive automatically.

artistRoutes.get(
  '/follows',
  handler(async (req, res) => {
    const follows = await many(
      `SELECT a.id,
              a.name,
              a.image_url  AS "imageUrl",
              a.deezer_id AS "deezerId",
              a.mbid,
              fa.followed_at     AS "followedAt",
              fa.last_checked_at AS "lastCheckedAt",
              fa.auto_add        AS "autoAdd",
              fa.include_singles AS "includeSingles",
              fa.include_compilations AS "includeCompilations",
              fa.target_playlist_id   AS "targetPlaylistId",
              p.name                  AS "targetPlaylistName",
              -- How much of this artist is already in the library, so the list
              -- is useful at a glance rather than just a list of names.
              (SELECT count(DISTINCT lt.track_id)::int
                 FROM library_tracks lt
                 JOIN track_artists ta ON ta.track_id = lt.track_id
                WHERE lt.user_id = fa.user_id AND ta.artist_id = a.id) AS "trackCount"
         FROM followed_artists fa
         JOIN artists a ON a.id = fa.artist_id
    LEFT JOIN playlists p ON p.id = fa.target_playlist_id
        WHERE fa.user_id = $1
     ORDER BY lower(a.name)`,
      [req.user.id]
    );
    res.json({ follows, discoveryEnabled: deezer.isEnabled() });
  })
);

// Follows an artist. Accepts an artist already in the catalogue by id, or a
// provider identity to create one from - the second case is what the search
// results page sends.
artistRoutes.post(
  '/follows',
  handler(async (req, res) => {
    let artistId = req.body?.artistId ? id(req.body.artistId, 'artistId') : null;

    if (!artistId) {
      const name = str(req.body?.name, 'Name', { required: true, max: 300 });
      const deezerId = str(req.body?.deezerId, 'deezerId', { max: 60 });
      const itunesId = str(req.body?.itunesId, 'itunesId', { max: 60 });
      const mbid = str(req.body?.mbid, 'mbid', { max: 60 });

      // Enrich from Deezer when possible, so a followed artist has a picture
      // rather than just a name. Best-effort: a failed lookup costs an image,
      // not the follow.
      let imageUrl = null;
      if (deezerId && deezer.isEnabled()) {
        try {
          const artist = await deezer.getArtist(deezerId);
          imageUrl = artist?.imageUrl || null;
        } catch (err) {
          console.error('[artists] deezer artist lookup failed:', err.message);
        }
      }

      const row = await one(
        `INSERT INTO artists (match_key, name, deezer_id, itunes_id, mbid, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (match_key) DO UPDATE
            SET name       = EXCLUDED.name,
                deezer_id  = COALESCE(artists.deezer_id, EXCLUDED.deezer_id),
                itunes_id  = COALESCE(artists.itunes_id, EXCLUDED.itunes_id),
                mbid       = COALESCE(artists.mbid, EXCLUDED.mbid),
                image_url  = COALESCE(EXCLUDED.image_url, artists.image_url),
                updated_at = now()
         RETURNING id`,
        [matchKey({ deezerId, itunesId, mbid, name }), name, deezerId, itunesId, mbid, imageUrl]
      );
      artistId = row.id;
    }

    const targetPlaylistId = req.body?.targetPlaylistId
      ? id(req.body.targetPlaylistId, 'targetPlaylistId')
      : null;
    if (targetPlaylistId) {
      const owned = await one(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [targetPlaylistId, req.user.id]
      );
      if (!owned) throw notFound('Target playlist not found.');
    }

    await query(
      `INSERT INTO followed_artists
         (user_id, artist_id, auto_add, include_singles, include_compilations, target_playlist_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, artist_id) DO UPDATE
          SET auto_add             = EXCLUDED.auto_add,
              include_singles      = EXCLUDED.include_singles,
              include_compilations = EXCLUDED.include_compilations,
              target_playlist_id   = EXCLUDED.target_playlist_id`,
      [
        req.user.id,
        artistId,
        bool(req.body?.autoAdd, true),
        bool(req.body?.includeSingles, true),
        bool(req.body?.includeCompilations, false),
        targetPlaylistId,
      ]
    );

    // Following someone means "tell me what is new from now on" by default, so
    // the existing catalogue is recorded as already-seen without adding any of
    // it. Asking for the back catalogue as well is a deliberate choice, and it
    // is the same code path with that baselining skipped: with nothing marked
    // seen, every release reads as new and gets added.
    if (bool(req.body?.importExisting, false)) {
      startBackfill(req.user.id, artistId);
      return res.status(202).json({ artistId, importing: true });
    }

    const baseline = await checkFollowedArtist(req.user.id, artistId, {
      baselineOnly: true,
    });

    res.status(201).json({ artistId, baseline });
  })
);

// Back-catalogue imports, and how far along they are.
//
// An artist with fifty releases is several hundred tracks, each needing a
// Deezer lookup and a resolution pass - minutes of work, far past what a
// request should hold open. So it runs detached and the page asks how it is
// going.
//
// In memory rather than in a table on purpose: this is progress, not a record.
// If the server restarts mid-import the answer the user needs is in their
// library, which is where the tracks actually landed, and a half-written job
// row would only be something else to reconcile. Keyed per user and artist, so
// two imports do not overwrite each other's state.
const backfills = new Map();
const backfillKey = (userId, artistId) => `${userId}:${artistId}`;

function startBackfill(userId, artistId) {
  const key = backfillKey(userId, artistId);
  if (backfills.get(key)?.state === 'running') return;

  backfills.set(key, { state: 'running', added: 0, failed: 0, startedAt: Date.now() });

  checkFollowedArtist(userId, artistId)
    .then((outcome) => {
      backfills.set(key, {
        state: 'done',
        added: outcome.added || 0,
        failed: outcome.failed || 0,
        releases: (outcome.newReleases || []).length,
        reason: outcome.checked ? null : outcome.reason,
      });
      console.log(
        `[follows] back catalogue for artist ${artistId}: ${outcome.added || 0} added, ` +
          `${outcome.failed || 0} failed`
      );
    })
    .catch((err) => {
      console.error('[follows] back catalogue import failed:', err.message);
      backfills.set(key, { state: 'failed', added: 0, failed: 0, reason: err.message });
    });
}

artistRoutes.get(
  '/follows/:id/import',
  handler(async (req, res) => {
    const artistId = id(req.params.id, 'artistId');
    const progress = backfills.get(backfillKey(req.user.id, artistId));
    res.json(progress || { state: 'idle' });
  })
);

artistRoutes.delete(
  '/follows/:id',
  handler(async (req, res) => {
    const artistId = id(req.params.id, 'Artist id');
    const { rowCount } = await query(
      'DELETE FROM followed_artists WHERE user_id = $1 AND artist_id = $2',
      [req.user.id, artistId]
    );
    if (rowCount === 0) throw notFound('You are not following that artist.');
    // The seen-releases record goes too, so re-following starts from a fresh
    // baseline rather than treating the last two years as already handled.
    await query(
      'DELETE FROM artist_release_seen WHERE user_id = $1 AND artist_id = $2',
      [req.user.id, artistId]
    );
    res.json({ ok: true });
  })
);

// Checks one followed artist for new releases now, rather than waiting for the
// scheduled sweep. Useful both for impatience and for confirming the feature
// works after setup.
artistRoutes.post(
  '/follows/:id/check',
  handler(async (req, res) => {
    const artistId = id(req.params.id, 'Artist id');
    const follow = await one(
      'SELECT artist_id FROM followed_artists WHERE user_id = $1 AND artist_id = $2',
      [req.user.id, artistId]
    );
    if (!follow) throw notFound('You are not following that artist.');
    res.json(await checkFollowedArtist(req.user.id, artistId));
  })
);

artistRoutes.get(
  '/:id',
  handler(async (req, res) => {
    const artistId = id(req.params.id, 'Artist id');
    const artist = await one(
      `SELECT a.id, a.name, a.image_url AS "imageUrl", a.deezer_id AS "deezerId",
              a.mbid, a.genres,
              (fa.user_id IS NOT NULL) AS followed
         FROM artists a
    LEFT JOIN followed_artists fa ON fa.artist_id = a.id AND fa.user_id = $1
        WHERE a.id = $2`,
      [req.user.id, artistId]
    );
    if (!artist) throw notFound('Artist not found.');

    artist.albums = await many(
      `SELECT al.id, al.name, al.artwork_url AS "artworkUrl",
              al.release_year AS "releaseYear", al.album_type AS "albumType",
              count(DISTINCT lt.track_id)::int AS "trackCount"
         FROM albums al
         JOIN tracks t ON t.album_id = al.id
         JOIN track_artists ta ON ta.track_id = t.id
         JOIN library_tracks lt ON lt.track_id = t.id AND lt.user_id = $1
        WHERE ta.artist_id = $2
     GROUP BY al.id
     ORDER BY al.release_year DESC NULLS LAST, lower(al.name)`,
      [req.user.id, artistId]
    );

    res.json(artist);
  })
);

// ---------------------------------------------------------------------------
// Credits that name more than one artist
// ---------------------------------------------------------------------------
//
// iTunes reports every credited artist as one string, so a track only it knew
// leaves a row on this page naming several people. Splitting those is checked
// against Deezer rather than guessed - see services/artist-split.js, and the
// note there about why "Earth, Wind & Fire" survives it.

artistRoutes.get(
  '/combined/count',
  handler(async (_req, res) => {
    res.json({ count: await countCombined() });
  })
);

artistRoutes.post(
  '/combined/repair',
  // Each one is a couple of outbound lookups, so this is not something to run
  // in a loop.
  rateLimit({ windowMs: 300_000, max: 3, key: (req) => `artistsplit:${req.user?.id}` }),
  handler(async (_req, res) => {
    const report = await repairArtists({ dryRun: false });
    res.json(report);
  })
);
