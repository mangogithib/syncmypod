import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, handler, id, notFound, pagination, str } from '../lib/api.js';
import { matchKey } from '../lib/normalise.js';
import * as deezer from '../providers/deezer.js';
import * as library from '../services/library.js';
import { appendToPlaylist } from '../services/playlist-writes.js';
import { absorb, countUnresolved, startRematch } from '../services/rematch.js';
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

    // Every candidate identity, remembered against the caller's own id for the
    // item so the answer can be handed back in the shape the page asked in.
    const wantedByRef = new Map();
    const allKeys = new Set();
    const allIsrcs = new Set();
    const allDeezer = new Set();
    const allItunes = new Set();
    const allMbids = new Set();

    items.forEach((item, index) => {
      const ref = String(item?.ref ?? index);
      const isrc = str(item?.isrc, 'ISRC', { max: 20 });
      const title = str(item?.title, 'Title', { max: 500 });
      const artist = str(item?.artist, 'Artist', { max: 500 });
      const album = str(item?.album, 'Album', { max: 500 });
      const deezerId = str(item?.deezerId, 'deezerId', { max: 60 });
      const itunesId = str(item?.itunesId, 'itunesId', { max: 60 });
      const mbid = str(item?.mbid, 'mbid', { max: 60 });

      const candidates = [];
      const push = (parts) => {
        const key = matchKey(parts);
        candidates.push(key);
        allKeys.add(key);
      };

      if (isrc) push({ isrc });
      if (deezerId) push({ deezerId });
      if (itunesId) push({ itunesId });
      if (mbid) push({ mbid });
      if (title) push({ name: title, extra: [artist, album].filter(Boolean).join(' ') });

      const normalisedIsrc = isrc ? isrc.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
      if (normalisedIsrc) allIsrcs.add(normalisedIsrc);
      if (deezerId) allDeezer.add(deezerId);
      if (itunesId) allItunes.add(itunesId);
      if (mbid) allMbids.add(mbid);

      wantedByRef.set(ref, { candidates, isrc: normalisedIsrc, deezerId, itunesId, mbid });
    });

    const rows = await library.knownTracks(req.user.id, {
      keys: [...allKeys],
      isrcs: [...allIsrcs],
      deezerIds: [...allDeezer],
      itunesIds: [...allItunes],
      mbids: [...allMbids],
    });

    const byKey = new Map(rows.map((row) => [row.matchKey, row.id]));
    const byIsrc = new Map(rows.filter((r) => r.isrc).map((r) => [r.isrc, r.id]));
    const byDeezer = new Map(rows.filter((r) => r.deezerId).map((r) => [String(r.deezerId), r.id]));
    const byItunes = new Map(rows.filter((r) => r.itunesId).map((r) => [String(r.itunesId), r.id]));
    const byMbid = new Map(rows.filter((r) => r.mbid).map((r) => [String(r.mbid), r.id]));

    const known = {};
    for (const [ref, wanted] of wantedByRef) {
      const hit =
        wanted.candidates.map((key) => byKey.get(key)).find(Boolean) ??
        (wanted.isrc ? byIsrc.get(wanted.isrc) : undefined) ??
        (wanted.deezerId ? byDeezer.get(wanted.deezerId) : undefined) ??
        (wanted.itunesId ? byItunes.get(wanted.itunesId) : undefined) ??
        (wanted.mbid ? byMbid.get(wanted.mbid) : undefined);
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

// "Stop flagging these", and its undo.
//
// Sets nothing about the track itself: the metadata stays unresolved, the sync
// still carries it with blank fields, and the Songs list still says so. All this
// changes is whether the Overview counts it - which is the difference between a
// warning that means something and one people have learned to scroll past.
libraryRoutes.post(
  '/tracks/attention',
  handler(async (req, res) => {
    const trackIds = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map((value) =>
      id(value, 'trackId')
    );
    if (trackIds.length === 0) throw badRequest('No trackIds supplied.');
    const dismissed = req.body?.dismissed !== false;

    const { rowCount } = await query(
      `UPDATE library_tracks
          SET attention_dismissed = $3
        WHERE user_id = $1 AND track_id = ANY($2::bigint[])`,
      [req.user.id, trackIds, dismissed]
    );

    res.json({ updated: rowCount, dismissed });
  })
);

// Removes many at once.
//
// POST rather than DELETE with a body: a body on DELETE is legal but poorly
// supported by proxies and by fetch, and this already sits beside a batched
// POST for adding. One transaction, so a selection of forty either leaves the
// library or does not.
libraryRoutes.post(
  '/tracks/remove',
  handler(async (req, res) => {
    const trackIds = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map((value) =>
      id(value, 'trackId')
    );
    if (trackIds.length === 0) throw badRequest('No trackIds supplied.');
    if (trackIds.length > 1000) throw badRequest('Too many tracks in one request (max 1000).');

    const removed = await transaction(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM library_tracks WHERE user_id = $1 AND track_id = ANY($2::bigint[])',
        [req.user.id, trackIds]
      );
      // Same reasoning as the single removal: a track out of the library must
      // not linger in a playlist that is about to be synced, or it goes
      // straight back onto the iPod.
      await client.query(
        `DELETE FROM playlist_tracks
          WHERE track_id = ANY($1::bigint[])
            AND playlist_id IN (SELECT id FROM playlists WHERE user_id = $2)`,
        [trackIds, req.user.id]
      );
      await forgetOnDevices(client, req.user.id, trackIds);
      return rowCount;
    });

    res.json({ removed, requested: trackIds.length });
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
    await forgetOnDevices({ query }, req.user.id, [trackId]);

    res.json({ ok: true });
  })
);

// Forgets that a paired computer was holding these tracks.
//
// `device_tracks` is append-only bookkeeping, and nothing was ever removing
// from it - so a library of 110 songs reported 696 on its iPod, which is every
// track ever written to it including the ones taken back out. The Devices page
// showed that number as "synced".
//
// **Safe because the server is not the authority here.** What is physically on
// an iPod is decided by the ledger kept on the device itself, and a removal
// sync plans from that ledger against the manifest - see `build_plan` in the
// local app. These rows only exist so a sync can skip work it has already done,
// and a track that is no longer in the library is no longer in the manifest, so
// they can never be consulted again.
async function forgetOnDevices(client, userId, trackIds) {
  await client.query(
    `DELETE FROM device_tracks
      WHERE track_id = ANY($1::bigint[])
        AND device_id IN (SELECT id FROM devices WHERE user_id = $2)`,
    [trackIds, userId]
  );
}

// Manual metadata correction. Sets metadata_state to 'manual', which the
// resolver treats as sacred: automated resolution will not overwrite it.
//
// **Only when something actually changed.** It used to be set on every save,
// so opening the dialog to read a track and pressing Save marked it corrected
// by hand - and `manual` is what exempts a track from every automatic repair
// there is. Songs sat with no artist, permanently outside the pass that exists
// to give them one, because somebody once looked at them. A save that changes
// nothing is not a correction.
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
              -- Compared against what is stored, not against what was sent:
              -- the dialog sends every field back whether or not it was
              -- touched, so "something was submitted" says nothing.
              metadata_state = CASE
                WHEN ($2 IS NOT NULL AND $2 IS DISTINCT FROM title)
                  OR ($3 IS NOT NULL AND $3 IS DISTINCT FROM artist_credit)
                  OR ($4 IS NOT NULL AND $4 IS DISTINCT FROM album_credit)
                  OR ($5 IS NOT NULL AND $5 IS DISTINCT FROM genre)
                  OR ($6 IS NOT NULL AND $6 IS DISTINCT FROM track_no)
                  OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM disc_no)
                THEN 'manual'
                ELSE metadata_state
              END,
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
                source_hint = COALESCE($4, source_hint),
                -- A pasted link is an answer to "this could not be found", so
                -- the mark that said so goes with it rather than sitting there
                -- contradicting the fix.
                source_missing = CASE
                  WHEN COALESCE(NULLIF($4, ''), NULL) IS NOT NULL THEN false
                  ELSE source_missing
                END
          WHERE user_id = $1 AND track_id = $2`,
        [
          req.user.id,
          trackId,
          req.body?.rating === undefined ? null : req.body.rating,
          req.body?.sourceHint === undefined ? null : req.body.sourceHint,
        ]
      );

      // Same reasoning for the "failed to sync" badge. The failure is real and
      // was recorded honestly, but it describes a sync that ran before there
      // was a link - so keeping it would mean the song still reads as broken
      // after the thing that broke it has been dealt with.
      //
      // Nothing is lost: if the pasted link does not work either, the next sync
      // records the failure again, with whatever went wrong that time.
      const pastedLink = str(req.body?.sourceHint, 'sourceHint', { max: 1000 });
      if (pastedLink) {
        await query(
          `DELETE FROM device_tracks
            WHERE track_id = $2
              AND state = 'failed'
              AND device_id IN (SELECT id FROM devices WHERE user_id = $1)`,
          [req.user.id, trackId]
        );
      }
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
// The same song, twice
// ---------------------------------------------------------------------------
//
// See findDuplicateGroups for why a library ends up holding one recording
// under two rows, and why this lists them rather than merging them itself.

libraryRoutes.get(
  '/duplicates',
  handler(async (req, res) => {
    const groups = await library.findDuplicateGroups(req.user.id);
    res.json({ groups, count: groups.length });
  })
);

// Folds one or more rows into another.
//
// Everything pointing at the rows being merged - library membership, playlist
// places, what a device is holding - is moved onto the one being kept before
// they are deleted, so a playlist keeps its song and the next sync does not
// re-download anything. That is `absorb`, which the automatic pass already
// uses; this is the same operation asked for by hand.
libraryRoutes.post(
  '/duplicates/merge',
  handler(async (req, res) => {
    const keepId = id(req.body?.keepId, 'keepId');
    const mergeIds = (Array.isArray(req.body?.mergeIds) ? req.body.mergeIds : []).map((value) =>
      id(value, 'mergeId')
    );
    if (mergeIds.length === 0) throw badRequest('No tracks to merge.');
    if (mergeIds.includes(keepId)) {
      throw badRequest('A track cannot be merged into itself.');
    }

    // Every row named has to be in this library. Without this the endpoint
    // would delete catalogue rows on behalf of somebody who does not hold them.
    const owned = await many(
      `SELECT track_id AS id FROM library_tracks
        WHERE user_id = $1 AND track_id = ANY($2::bigint[])`,
      [req.user.id, [keepId, ...mergeIds]]
    );
    const held = new Set(owned.map((row) => Number(row.id)));
    if (!held.has(keepId) || mergeIds.some((value) => !held.has(value))) {
      throw notFound('Those tracks are not all in your library.');
    }

    for (const mergeId of mergeIds) await absorb(mergeId, keepId);

    res.json({ merged: mergeIds.length, keepId });
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

// One album, for its own page.
//
// The page shows the whole release rather than only the songs already added,
// which needs a provider id - and a library album does not always carry one.
// So a missing id is looked up once, by name and album artist, and written
// back. That turns "some albums open a page and some open a dialog" into one
// behaviour, which is what it should have been.
//
// The lookup is best-effort in the strict sense: it never fails the request.
// Without it the page still lists what the library holds.
libraryRoutes.get(
  '/albums/:id',
  handler(async (req, res) => {
    const albumId = id(req.params.id, 'Album id');
    const album = await library.getAlbum(req.user.id, albumId);
    if (!album) throw notFound('Album not found.');

    if (!album.deezerId && deezer.isEnabled()) {
      album.deezerId = await findAlbumOnDeezer(album);
      if (album.deezerId) {
        await library.rememberAlbumDeezerId(albumId, album.deezerId).catch(() => {});
      }
    }

    res.json(album);
  })
);

// Deezer's own id for an album the library only knows by name.
//
// Matched on the album name and, where there is one, the album artist. A name
// alone is not enough - "Greatest Hits" belongs to several hundred people - so
// a candidate whose artist does not match is rejected rather than accepted as
// the best of a bad set.
async function findAlbumOnDeezer(album) {
  try {
    const term = [album.name, album.artistName].filter(Boolean).join(' ');
    const found = await deezer.searchAll(term, { types: 'album', limit: 10 });
    const wantedName = normaliseLoosely(album.name);
    const wantedArtist = normaliseLoosely(album.artistName || '');

    for (const candidate of found.albums || []) {
      if (normaliseLoosely(candidate.name) !== wantedName) continue;
      if (!wantedArtist) return candidate.deezerId || null;
      const credit = normaliseLoosely((candidate.artists || []).map((a) => a.name).join(' '));
      if (credit.includes(wantedArtist) || wantedArtist.includes(credit)) {
        return candidate.deezerId || null;
      }
    }
  } catch (err) {
    console.error('[library] deezer album lookup failed:', err.message);
  }
  return null;
}

// Case, punctuation and spacing removed. Enough to tell "Rockstar" from
// "Rockstar (Original Motion Picture Soundtrack)" apart from a real mismatch,
// without pulling in the resolver's scoring for a yes/no question.
function normaliseLoosely(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u0027\u0060]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

// One artist, for the page that opens from the Artists list.
//
// Same problem as an album: the page is provider-backed and an artist stored
// from iTunes has no Deezer id, so the row was a dead end. Looked up once by
// name and written back.
libraryRoutes.get(
  '/artists/:id',
  handler(async (req, res) => {
    const artistId = id(req.params.id, 'Artist id');
    const artist = await library.getArtistForPage(req.user.id, artistId);
    if (!artist) throw notFound('Artist not found.');

    if (!artist.deezerId && deezer.isEnabled()) {
      artist.deezerId = await findArtistOnDeezer(artist.name);
      if (artist.deezerId) {
        await library.rememberArtistDeezerId(artistId, artist.deezerId).catch(() => {});
      }
    }

    res.json(artist);
  })
);

// Which library artist a provider page is about, so it can lead with the songs
// already held. Returns null rather than 404 - "none" is an ordinary answer.
libraryRoutes.get(
  '/artists/by-deezer/:deezerId',
  handler(async (req, res) => {
    const deezerId = str(req.params.deezerId, 'deezerId', { max: 60 });
    res.json({ artist: deezerId ? await library.findArtistByDeezerId(req.user.id, deezerId) : null });
  })
);

async function findArtistOnDeezer(name) {
  try {
    const found = await deezer.searchAll(name, { types: 'artist', limit: 5 });
    const wanted = normaliseLoosely(name);
    const hit = (found.artists || []).find(
      (candidate) => normaliseLoosely(candidate.name) === wanted
    );
    return hit?.deezerId || null;
  } catch (err) {
    console.error('[library] deezer artist lookup failed:', err.message);
    return null;
  }
}

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
