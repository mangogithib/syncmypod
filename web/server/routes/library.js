import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, handler, id, notFound, pagination, str } from '../lib/api.js';
import { matchKey } from '../lib/normalise.js';
import * as library from '../services/library.js';
import { appendToPlaylist } from '../services/playlist-writes.js';
import { countUnresolved, startRematch } from '../services/rematch.js';
import {
  resolveAndSave,
  resolveTrack,
  saveResolvedTrack,
  saveUnresolvedTrack,
} from '../services/resolver.js';

export const libraryRoutes = Router();
libraryRoutes.use(requireUser);

libraryRoutes.get(
  '/stats',
  handler(async (req, res) => {
    res.json(await library.libraryStats(req.user.id));
  })
);

libraryRoutes.get(
  '/tracks',
  handler(async (req, res) => {
    const { limit, offset } = pagination(req.query);
    res.json(
      await library.listLibraryTracks(req.user.id, {
        search: str(req.query.q, 'Search', { max: 200 }),
        albumId: req.query.albumId ? id(req.query.albumId, 'albumId') : null,
        artistId: req.query.artistId ? id(req.query.artistId, 'artistId') : null,
        playlistId: req.query.playlistId ? id(req.query.playlistId, 'playlistId') : null,
        metadataState: str(req.query.state, 'State', { max: 20 }),
        sort: str(req.query.sort, 'Sort', { max: 20 }) || 'added',
        limit,
        offset,
      })
    );
  })
);

libraryRoutes.get(
  '/tracks/:id',
  handler(async (req, res) => {
    const track = await library.getTrack(req.user.id, id(req.params.id, 'Track id'));
    if (!track) throw notFound('Track not found.');
    res.json(track);
  })
);

// Which of these provider results are already in the library.
//
// The artist and album pages read from the providers rather than from the
// library, which is what lets them show music not added yet - but it also meant
// every row offered "Add", including the forty you added last week. Answering
// that needs the library's own idea of identity, which lives on the server.
//
// **Why several keys per item rather than one.** `matchKey` prefers an ISRC and
// falls back to a provider id, so the same recording can be stored under
// `isrc:...` (resolved through Deezer's track endpoint, which returns one) and
// arrive here as `dz:...` (from an album listing, which does not). Comparing a
// single key would miss it and offer to add a duplicate. So every key the item
// could plausibly have been stored under is tried, plus the ISRC column
// directly.
//
// Read-only and cheap: one query, no provider calls, nothing resolved.
libraryRoutes.post(
  '/known',
  handler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.json({ known: {} });
    if (items.length > 500) throw badRequest('Too many items in one request (max 500).');

    // Every candidate key, remembered against the caller's own id for the item
    // so the answer can be handed back in the shape the page asked in.
    const keysByRef = new Map();
    const allKeys = new Set();
    const allIsrcs = new Set();

    items.forEach((item, index) => {
      const ref = String(item?.ref ?? index);
      const isrc = str(item?.isrc, 'ISRC', { max: 20 });
      const title = str(item?.title, 'Title', { max: 500 });
      const artist = str(item?.artist, 'Artist', { max: 500 });
      const album = str(item?.album, 'Album', { max: 500 });

      const candidates = [];
      const push = (parts) => {
        const key = matchKey(parts);
        candidates.push(key);
        allKeys.add(key);
      };

      if (isrc) push({ isrc });
      if (item?.deezerId) push({ deezerId: str(item.deezerId, 'deezerId', { max: 60 }) });
      if (item?.itunesId) push({ itunesId: str(item.itunesId, 'itunesId', { max: 60 }) });
      if (item?.mbid) push({ mbid: str(item.mbid, 'mbid', { max: 60 }) });
      if (title) push({ name: title, extra: [artist, album].filter(Boolean).join(' ') });

      if (isrc) allIsrcs.add(isrc.toUpperCase().replace(/[^A-Z0-9]/g, ''));
      keysByRef.set(ref, { candidates, isrc });
    });

    const rows = await library.knownTracks(req.user.id, {
      keys: [...allKeys],
      isrcs: [...allIsrcs],
    });

    const byKey = new Map(rows.map((row) => [row.matchKey, row.id]));
    const byIsrc = new Map(rows.filter((r) => r.isrc).map((r) => [r.isrc, r.id]));

    const known = {};
    for (const [ref, { candidates, isrc }] of keysByRef) {
      const hit =
        candidates.map((key) => byKey.get(key)).find(Boolean) ??
        (isrc ? byIsrc.get(isrc.toUpperCase().replace(/[^A-Z0-9]/g, '')) : undefined);
      if (hit) known[ref] = Number(hit);
    }

    res.json({ known });
  })
);

// Adds tracks to the library.
//
// Accepts two kinds of item, because the two are genuinely different:
//
//   * { trackId }  - already in the catalogue. Nothing to resolve.
//   * { title, artist, album, isrc, deezerId, ... } - a description that must
//     be resolved against a provider first.
//
// Batched on purpose: adding a 40-track album is one request, and the report
// says what happened to each item rather than failing the lot on one bad row.
libraryRoutes.post(
  '/tracks',
  handler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (items.length === 0) throw badRequest('No tracks supplied.');
    if (items.length > 200) {
      throw badRequest('Add at most 200 tracks per request.');
    }

    const addedVia = str(req.body?.addedVia, 'addedVia', { max: 40 }) || 'manual';
    const playlistId = req.body?.playlistId
      ? id(req.body.playlistId, 'playlistId')
      : null;

    if (playlistId) {
      const owned = await one(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, req.user.id]
      );
      if (!owned) throw notFound('Playlist not found.');
    }

    const report = [];
    for (const item of items) {
      try {
        let trackId;
        let state = 'resolved';

        if (item?.trackId) {
          trackId = id(item.trackId, 'trackId');
          const exists = await one('SELECT id FROM tracks WHERE id = $1', [trackId]);
          if (!exists) throw notFound(`Track ${trackId} not found.`);
        } else if (item?.skipResolve) {
          // Saved with a title and nothing else, on purpose.
          //
          // This is the YouTube path. A video title and a channel name are not
          // metadata - the channel is not the artist, and there is no album at
          // all - so writing them into those fields produces a library that
          // looks populated and is wrong. Running the resolver on them is no
          // better: it matches a title against the catalogues with no artist to
          // check against, and confidently returns the wrong recording.
          //
          // So nothing is guessed. The track lands unresolved, which the
          // manifest excludes from syncing until someone fills in the artist
          // and album by hand - at which point it becomes 'manual' and syncs.
          // An empty field the user can see and fix beats a filled one they
          // have to notice is wrong.
          trackId = await saveUnresolvedTrack(
            {
              title: str(item?.title, 'Title', { required: true, max: 500 }),
              artist: '',
              album: null,
              durationMs: item?.durationMs ? Number(item.durationMs) : null,
              matchKeyExtra: str(item?.sourceHint, 'sourceHint', { max: 1000 }),
            },
            null
          );
          state = 'unresolved';
        } else {
          const outcome = await resolveAndSave({
            title: str(item?.title, 'Title', { required: true, max: 500 }),
            artist: str(item?.artist, 'Artist', { max: 500 }),
            album: str(item?.album, 'Album', { max: 500 }),
            isrc: str(item?.isrc, 'ISRC', { max: 20 }),
            deezerId: str(item?.deezerId, 'deezerId', { max: 60 }),
            itunesId: str(item?.itunesId, 'itunesId', { max: 60 }),
            mbid: str(item?.mbid, 'mbid', { max: 60 }),
            durationMs: item?.durationMs ? Number(item.durationMs) : null,
          });
          trackId = outcome.trackId;
          state = outcome.resolution.state;
        }

        await query(
          `INSERT INTO library_tracks (user_id, track_id, added_via, source_hint)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, track_id) DO NOTHING`,
          [req.user.id, trackId, addedVia, str(item?.sourceHint, 'sourceHint', { max: 1000 })]
        );

        if (playlistId) await appendToPlaylist(playlistId, trackId);

        report.push({ ok: true, trackId, metadataState: state, input: item?.title });
      } catch (err) {
        // One unresolvable track must not abandon the other 39.
        report.push({ ok: false, error: err.message, input: item?.title });
      }
    }

    res.json({
      added: report.filter((entry) => entry.ok).length,
      failed: report.filter((entry) => !entry.ok).length,
      report,
    });
  })
);

libraryRoutes.delete(
  '/tracks/:id',
  handler(async (req, res) => {
    const trackId = id(req.params.id, 'Track id');
    // Removes library membership, not the catalogue row. The track may be in
    // someone else's library, referenced by a playlist, or simply worth keeping
    // as a resolved record for when it is added again.
    const { rowCount } = await query(
      'DELETE FROM library_tracks WHERE user_id = $1 AND track_id = $2',
      [req.user.id, trackId]
    );
    if (rowCount === 0) throw notFound('Track is not in your library.');

    // A track removed from the library should not linger in playlists that are
    // about to be synced - that would put it straight back on the iPod.
    await query(
      `DELETE FROM playlist_tracks
        WHERE track_id = $1
          AND playlist_id IN (SELECT id FROM playlists WHERE user_id = $2)`,
      [trackId, req.user.id]
    );

    res.json({ ok: true });
  })
);

// Manual metadata correction. Sets metadata_state to 'manual', which the
// resolver treats as sacred: automated resolution will not overwrite it.
libraryRoutes.patch(
  '/tracks/:id',
  handler(async (req, res) => {
    const trackId = id(req.params.id, 'Track id');

    const inLibrary = await one(
      'SELECT 1 FROM library_tracks WHERE user_id = $1 AND track_id = $2',
      [req.user.id, trackId]
    );
    if (!inLibrary) throw notFound('Track is not in your library.');

    const title = str(req.body?.title, 'Title', { max: 500 });
    const artistCredit = str(req.body?.artistCredit, 'Artist', { max: 500 });
    const albumCredit = str(req.body?.albumCredit, 'Album', { max: 500 });
    const genre = str(req.body?.genre, 'Genre', { max: 120 });
    const trackNo = req.body?.trackNo === null ? null : req.body?.trackNo;
    const discNo = req.body?.discNo === null ? null : req.body?.discNo;

    const updated = await one(
      `UPDATE tracks
          SET title         = COALESCE($2, title),
              artist_credit = COALESCE($3, artist_credit),
              album_credit  = COALESCE($4, album_credit),
              genre         = COALESCE($5, genre),
              track_no      = COALESCE($6, track_no),
              disc_no       = COALESCE($7, disc_no),
              metadata_state = 'manual',
              updated_at    = now()
        WHERE id = $1
        RETURNING id`,
      [
        trackId,
        title,
        artistCredit,
        albumCredit,
        genre,
        trackNo === undefined ? null : trackNo,
        discNo === undefined ? null : discNo,
      ]
    );
    if (!updated) throw notFound('Track not found.');

    // Per-user fields live on library_tracks, not on the shared catalogue row.
    if (req.body?.rating !== undefined || req.body?.sourceHint !== undefined) {
      await query(
        `UPDATE library_tracks
            SET rating      = COALESCE($3, rating),
                source_hint = COALESCE($4, source_hint)
          WHERE user_id = $1 AND track_id = $2`,
        [
          req.user.id,
          trackId,
          req.body?.rating === undefined ? null : req.body.rating,
          req.body?.sourceHint === undefined ? null : req.body.sourceHint,
        ]
      );
    }

    res.json(await library.getTrack(req.user.id, trackId));
  })
);

// Re-run resolution for one track. For the case where metadata was wrong, or a
// track was resolved before a better provider was available.
libraryRoutes.post(
  '/tracks/:id/resolve',
  handler(async (req, res) => {
    const trackId = id(req.params.id, 'Track id');
    const track = await one(
      `SELECT t.id, t.title, t.artist_credit, t.album_credit, t.isrc,
              t.deezer_id, t.itunes_id, t.mbid, t.duration_ms, t.metadata_state
         FROM tracks t
         JOIN library_tracks lt ON lt.track_id = t.id AND lt.user_id = $1
        WHERE t.id = $2`,
      [req.user.id, trackId]
    );
    if (!track) throw notFound('Track is not in your library.');

    const resolution = await resolveTrack({
      title: track.title,
      artist: track.artist_credit,
      album: track.album_credit,
      isrc: track.isrc,
      // Re-resolution deliberately ignores a stored provider id when the caller
      // asks to search again, since a wrong id is often the reason the metadata
      // was wrong in the first place.
      deezerId: req.body?.ignoreIds ? null : track.deezer_id,
      itunesId: req.body?.ignoreIds ? null : track.itunes_id,
      mbid: req.body?.ignoreIds ? null : track.mbid,
      durationMs: track.duration_ms,
      preferProvider: req.body?.provider,
    });

    if (resolution.state !== 'resolved') {
      return res.json({ ok: false, resolution });
    }

    // A manual correction is only overwritten when the request says so
    // explicitly, so a bulk re-resolve cannot undo hand-fixed tags.
    if (track.metadata_state === 'manual' && !req.body?.overwriteManual) {
      return res.json({
        ok: false,
        reason: 'This track has manual metadata. Pass overwriteManual to replace it.',
        resolution,
      });
    }

    await transaction(async (client) => {
      if (track.metadata_state === 'manual') {
        await client.query(
          `UPDATE tracks SET metadata_state = 'resolved' WHERE id = $1`,
          [trackId]
        );
      }
      await saveResolvedTrack(resolution, { client });
    });

    res.json({ ok: true, track: await library.getTrack(req.user.id, trackId) });
  })
);

// ---------------------------------------------------------------------------
// Albums and artists as browsable views of the library
// ---------------------------------------------------------------------------

libraryRoutes.get(
  '/albums',
  handler(async (req, res) => {
    const { limit, offset } = pagination(req.query, { defaultLimit: 60 });
    res.json(
      await library.listAlbums(req.user.id, {
        search: str(req.query.q, 'Search', { max: 200 }),
        limit,
        offset,
      })
    );
  })
);

libraryRoutes.get(
  '/artists',
  handler(async (req, res) => {
    const { limit, offset } = pagination(req.query, { defaultLimit: 100 });
    res.json(
      await library.listArtists(req.user.id, {
        search: str(req.query.q, 'Search', { max: 200 }),
        limit,
        offset,
      })
    );
  })
);

// ---------------------------------------------------------------------------
// Another go at the songs nothing could identify
// ---------------------------------------------------------------------------
//
// These exist because the odds changed. A track stored with a title and no
// artist was, until YouTube Music was added, close to unmatchable - a title on
// its own is not enough to identify a recording. YouTube Music answers with
// structured fields, so those tracks are worth asking about again.

libraryRoutes.get(
  '/unresolved/count',
  handler(async (req, res) => {
    res.json({ count: await countUnresolved(req.user.id) });
  })
);

libraryRoutes.post(
  '/unresolved/rematch',
  // A pass over a whole library is a burst of outbound provider requests, and
  // running two at once would double them for no gain.
  rateLimit({ windowMs: 300_000, max: 3, key: (req) => `rematch:${req.user?.id}` }),
  handler(async (req, res) => {
    try {
      const { jobId, total } = await startRematch(req.user.id);
      // 202: accepted and running, not finished. The client polls the job.
      res.status(202).json({ jobId, total });
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);
