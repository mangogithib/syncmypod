import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import { many, one, query, transaction } from '../db/pool.js';
import {
  badRequest,
  bool,
  conflict,
  handler,
  id,
  notFound,
  str,
} from '../lib/api.js';

export const playlistRoutes = Router();
playlistRoutes.use(requireUser);

playlistRoutes.get(
  '/',
  handler(async (req, res) => {
    const playlists = await many(
      `SELECT p.id,
              p.name,
              p.description,
              p.source,
              p.source_ref     AS "sourceRef",
              p.sync_to_ipod   AS "syncToIpod",
              p.created_at     AS "createdAt",
              p.updated_at     AS "updatedAt",
              count(pt.track_id)::int          AS "trackCount",
              coalesce(sum(t.duration_ms), 0)::bigint AS "durationMs",
              -- The artwork of the first track that has any, so a playlist has
              -- a thumbnail without storing one.
              (SELECT al.artwork_url
                 FROM playlist_tracks pt2
                 JOIN tracks t2  ON t2.id = pt2.track_id
                 JOIN albums al  ON al.id = t2.album_id
                WHERE pt2.playlist_id = p.id AND al.artwork_url IS NOT NULL
             ORDER BY pt2.position
                LIMIT 1) AS "artworkUrl"
         FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    LEFT JOIN tracks t ON t.id = pt.track_id
        WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY lower(p.name)`,
      [req.user.id]
    );
    res.json({ playlists });
  })
);

playlistRoutes.post(
  '/',
  handler(async (req, res) => {
    const name = str(req.body?.name, 'Name', { required: true, max: 200, min: 1 });
    const description = str(req.body?.description, 'Description', { max: 1000 });

    try {
      const playlist = await one(
        `INSERT INTO playlists (user_id, name, description, sync_to_ipod)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, source, sync_to_ipod AS "syncToIpod",
                   created_at AS "createdAt"`,
        [req.user.id, name, description, bool(req.body?.syncToIpod, true)]
      );
      res.status(201).json(playlist);
    } catch (err) {
      // 23505 = unique violation on (user_id, lower(name)).
      if (err.code === '23505') {
        throw conflict(`You already have a playlist called "${name}".`);
      }
      throw err;
    }
  })
);

playlistRoutes.get(
  '/:id',
  handler(async (req, res) => {
    const playlistId = id(req.params.id, 'Playlist id');
    const playlist = await one(
      `SELECT id, name, description, source, source_ref AS "sourceRef",
              sync_to_ipod AS "syncToIpod", created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM playlists WHERE id = $1 AND user_id = $2`,
      [playlistId, req.user.id]
    );
    if (!playlist) throw notFound('Playlist not found.');

    playlist.tracks = await many(
      `SELECT t.id,
              t.title,
              t.artist_credit  AS "artistCredit",
              t.album_credit   AS "albumCredit",
              t.duration_ms    AS "durationMs",
              t.metadata_state AS "metadataState",
              al.artwork_url   AS "artworkUrl",
              al.id            AS "albumId",
              pt.position,
              -- Flags a playlist entry whose track is no longer in the library.
              -- An import can add playlist rows for tracks the user later
              -- removed, and the sync manifest must not include them.
              (lt.user_id IS NOT NULL) AS "inLibrary"
         FROM playlist_tracks pt
         JOIN tracks t   ON t.id = pt.track_id
    LEFT JOIN albums al  ON al.id = t.album_id
    LEFT JOIN library_tracks lt ON lt.track_id = t.id AND lt.user_id = $2
        WHERE pt.playlist_id = $1
     ORDER BY pt.position`,
      [playlistId, req.user.id]
    );

    res.json(playlist);
  })
);

playlistRoutes.patch(
  '/:id',
  handler(async (req, res) => {
    const playlistId = id(req.params.id, 'Playlist id');
    const name = str(req.body?.name, 'Name', { max: 200 });
    const description = str(req.body?.description, 'Description', { max: 1000 });
    const syncToIpod =
      req.body?.syncToIpod === undefined ? null : bool(req.body.syncToIpod, true);

    try {
      const playlist = await one(
        `UPDATE playlists
            SET name         = COALESCE($3, name),
                description  = COALESCE($4, description),
                sync_to_ipod = COALESCE($5, sync_to_ipod),
                updated_at   = now()
          WHERE id = $1 AND user_id = $2
          RETURNING id, name, description, sync_to_ipod AS "syncToIpod"`,
        [playlistId, req.user.id, name, description, syncToIpod]
      );
      if (!playlist) throw notFound('Playlist not found.');
      res.json(playlist);
    } catch (err) {
      if (err.code === '23505') {
        throw conflict(`You already have a playlist called "${name}".`);
      }
      throw err;
    }
  })
);

playlistRoutes.delete(
  '/:id',
  handler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM playlists WHERE id = $1 AND user_id = $2',
      [id(req.params.id, 'Playlist id'), req.user.id]
    );
    if (rowCount === 0) throw notFound('Playlist not found.');
    // playlist_tracks rows go with it via ON DELETE CASCADE. The tracks
    // themselves stay in the library - deleting a playlist is not deleting music.
    res.json({ ok: true });
  })
);

// Adds tracks that are already in the catalogue. Resolving new tracks is
// /api/library/tracks with a playlistId, which keeps resolution in one place.
playlistRoutes.post(
  '/:id/tracks',
  handler(async (req, res) => {
    const playlistId = id(req.params.id, 'Playlist id');
    const trackIds = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : [])
      .map((value) => id(value, 'trackId'));
    if (trackIds.length === 0) throw badRequest('No trackIds supplied.');

    const owned = await one(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, req.user.id]
    );
    if (!owned) throw notFound('Playlist not found.');

    const added = await transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT COALESCE(max(position), 0) AS max FROM playlist_tracks WHERE playlist_id = $1',
        [playlistId]
      );
      let position = Number(rows[0].max);
      let count = 0;

      for (const trackId of trackIds) {
        position += 10;
        const result = await client.query(
          `INSERT INTO playlist_tracks (playlist_id, track_id, position)
           VALUES ($1, $2, $3)
           ON CONFLICT (playlist_id, track_id) DO NOTHING`,
          [playlistId, trackId, position]
        );
        // A track already in the playlist is not an error, but it should not be
        // counted as added either.
        if (result.rowCount > 0) count++;
        else position -= 10;
      }

      await client.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [
        playlistId,
      ]);
      return count;
    });

    res.json({ added, requested: trackIds.length });
  })
);

playlistRoutes.delete(
  '/:id/tracks/:trackId',
  handler(async (req, res) => {
    const playlistId = id(req.params.id, 'Playlist id');
    const trackId = id(req.params.trackId, 'Track id');

    const owned = await one(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, req.user.id]
    );
    if (!owned) throw notFound('Playlist not found.');

    const { rowCount } = await query(
      'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
      [playlistId, trackId]
    );
    if (rowCount === 0) throw notFound('Track is not in this playlist.');

    await query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlistId]);
    res.json({ ok: true });
  })
);

// Reorders the whole playlist from an ordered list of track ids.
//
// Takes the full order rather than a move instruction: a drag-and-drop UI
// already knows the resulting order, and sending it whole means no chance of the
// client and server disagreeing about intermediate state.
playlistRoutes.put(
  '/:id/order',
  handler(async (req, res) => {
    const playlistId = id(req.params.id, 'Playlist id');
    const trackIds = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map(
      (value) => id(value, 'trackId')
    );
    if (trackIds.length === 0) throw badRequest('trackIds must be a non-empty array.');

    const owned = await one(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, req.user.id]
    );
    if (!owned) throw notFound('Playlist not found.');

    await transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT track_id FROM playlist_tracks WHERE playlist_id = $1',
        [playlistId]
      );
      const existing = new Set(rows.map((row) => row.track_id));

      // Refuse a partial order outright. Silently keeping unlisted tracks at
      // some arbitrary position is the kind of thing that quietly scrambles a
      // playlist, so a mismatch is a client bug worth surfacing.
      if (trackIds.length !== existing.size) {
        throw badRequest(
          `Order must list every track in the playlist (${existing.size} expected, ${trackIds.length} given).`
        );
      }
      for (const trackId of trackIds) {
        if (!existing.has(trackId)) {
          throw badRequest(`Track ${trackId} is not in this playlist.`);
        }
      }

      // One UPDATE against a VALUES list, rather than a statement per track: a
      // 500-track reorder should not be 500 round trips.
      //
      // These ids are interpolated rather than parameterised, which is safe only
      // because every one has already been through id() above - it throws on
      // anything that is not a positive integer - and because each was just
      // confirmed to be a member of this playlist. Nothing user-typed reaches
      // this string.
      const values = trackIds
        .map((trackId, index) => `(${trackId}, ${(index + 1) * 10})`)
        .join(', ');
      await client.query(
        `UPDATE playlist_tracks pt
            SET position = v.position
           FROM (VALUES ${values}) AS v(track_id, position)
          WHERE pt.playlist_id = $1 AND pt.track_id = v.track_id`,
        [playlistId]
      );
      await client.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [
        playlistId,
      ]);
    });

    res.json({ ok: true });
  })
);
