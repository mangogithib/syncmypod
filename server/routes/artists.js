import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import { many, one, query } from '../db/pool.js';
import { badRequest, bool, handler, id, notFound, str } from '../lib/api.js';
import { matchKey } from '../lib/normalise.js';
import * as spotify from '../providers/spotify.js';
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
              a.spotify_id AS "spotifyId",
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
    res.json({ follows, spotifyEnabled: spotify.isEnabled() });
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
      const spotifyId = str(req.body?.spotifyId, 'spotifyId', { max: 60 });
      const mbid = str(req.body?.mbid, 'mbid', { max: 60 });

      // Enrich from Spotify when possible, so a followed artist has an image and
      // genres rather than just a name.
      let imageUrl = null;
      let genres = null;
      if (spotifyId && spotify.isEnabled()) {
        try {
          const artist = await spotify.getArtist(spotifyId);
          imageUrl = artist?.imageUrl || null;
          genres = artist?.genres || null;
        } catch (err) {
          console.error('[artists] spotify artist lookup failed:', err.message);
        }
      }

      const row = await one(
        `INSERT INTO artists (match_key, name, spotify_id, mbid, image_url, genres)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (match_key) DO UPDATE
            SET name       = EXCLUDED.name,
                spotify_id = COALESCE(artists.spotify_id, EXCLUDED.spotify_id),
                mbid       = COALESCE(artists.mbid, EXCLUDED.mbid),
                image_url  = COALESCE(EXCLUDED.image_url, artists.image_url),
                updated_at = now()
         RETURNING id`,
        [
          matchKey({ spotifyId, mbid, name }),
          name,
          spotifyId,
          mbid,
          imageUrl,
          genres,
        ]
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

    // The artist's existing catalogue is recorded as already-seen without adding
    // any of it. Following someone should mean "tell me what is new from now
    // on", not "download twenty years of back catalogue tonight".
    const baseline = await checkFollowedArtist(req.user.id, artistId, {
      baselineOnly: true,
    });

    res.status(201).json({ artistId, baseline });
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
      `SELECT a.id, a.name, a.image_url AS "imageUrl", a.spotify_id AS "spotifyId",
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

// Bulk-imports the artists a user already follows on Spotify. Follows only -
// their music is not added, for the same reason as the baseline above.
artistRoutes.post(
  '/follows/import-spotify',
  handler(async (req, res) => {
    if (!spotify.isEnabled()) {
      throw badRequest('Spotify is not configured.');
    }

    const artists = await spotify.getMyFollowedArtists(req.user.id);
    let imported = 0;

    for (const artist of artists) {
      const row = await one(
        `INSERT INTO artists (match_key, name, spotify_id, image_url, genres)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (match_key) DO UPDATE
            SET image_url = COALESCE(EXCLUDED.image_url, artists.image_url),
                genres    = COALESCE(EXCLUDED.genres, artists.genres),
                updated_at = now()
         RETURNING id`,
        [
          matchKey({ spotifyId: artist.spotifyId, name: artist.name }),
          artist.name,
          artist.spotifyId,
          artist.imageUrl,
          artist.genres,
        ]
      );

      const result = await query(
        `INSERT INTO followed_artists (user_id, artist_id, auto_add)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, artist_id) DO NOTHING`,
        [req.user.id, row.id, bool(req.body?.autoAdd, false)]
      );
      if (result.rowCount > 0) {
        imported++;
        await checkFollowedArtist(req.user.id, row.id, { baselineOnly: true });
      }
    }

    res.json({ imported, total: artists.length });
  })
);
