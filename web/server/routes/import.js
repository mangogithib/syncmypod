import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { many, one } from '../db/pool.js';
import { badRequest, bool, handler, id, notFound, str } from '../lib/api.js';
import {
  getJob,
  parseTrackList,
  startDeezerPlaylistImport,
  startTrackListImport,
  startYouTubePlaylistImport,
} from '../services/import.js';

export const importRoutes = Router();
importRoutes.use(requireUser);

// Bulk import. No source here needs an account or a key - see services/import.js.
//
// There is no OAuth here any more. The Spotify integration that used to live in
// this file needed it, and went when Spotify started refusing Web API access to
// apps whose owner is not a Premium subscriber.

// Shows what a pasted list would be understood as, without importing anything.
//
// Worth its own endpoint because the "Artist - Title" versus "Title - Artist"
// choice is genuinely ambiguous and getting it wrong across 300 lines is
// tedious to undo. Seeing the first few parsed rows makes the decision obvious
// before committing to it.
importRoutes.post(
  '/preview',
  handler(async (req, res) => {
    const text = String(req.body?.text || '');
    if (text.length > 500_000) throw badRequest('That list is too long.');

    const order = req.body?.order === 'title-artist' ? 'title-artist' : 'artist-title';
    const parsed = parseTrackList(text, order);

    res.json({
      total: parsed.length,
      order,
      sample: parsed.slice(0, 8),
    });
  })
);

importRoutes.post(
  '/track-list',
  // Each import is a burst of outbound provider requests, so starting them is
  // limited even though the work itself happens in the background.
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const text = String(req.body?.text || '');
    if (!text.trim()) throw badRequest('Paste a list of tracks first.');
    if (text.length > 500_000) throw badRequest('That list is too long.');

    const targetPlaylistId = req.body?.targetPlaylistId
      ? id(req.body.targetPlaylistId, 'targetPlaylistId')
      : null;
    if (targetPlaylistId) await assertOwnedPlaylist(targetPlaylistId, req.user.id);

    const jobId = await startTrackListImport(req.user.id, text, {
      order: req.body?.order === 'title-artist' ? 'title-artist' : 'artist-title',
      name: str(req.body?.playlistName, 'Playlist name', { max: 200 }),
      createPlaylist: bool(req.body?.createPlaylist, false),
      targetPlaylistId,
    });

    // 202: accepted and running, not finished. The client polls the job.
    res.status(202).json({ jobId });
  })
);

importRoutes.post(
  '/deezer-playlist',
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const ref = str(req.body?.playlist, 'Playlist', { required: true, max: 500 });

    const targetPlaylistId = req.body?.targetPlaylistId
      ? id(req.body.targetPlaylistId, 'targetPlaylistId')
      : null;
    if (targetPlaylistId) await assertOwnedPlaylist(targetPlaylistId, req.user.id);

    try {
      const jobId = await startDeezerPlaylistImport(req.user.id, ref, {
        createPlaylist: bool(req.body?.createPlaylist, true),
        targetPlaylistId,
      });
      res.status(202).json({ jobId });
    } catch (err) {
      // A malformed URL is the user's mistake to correct, not a server fault.
      throw badRequest(err.message);
    }
  })
);

importRoutes.post(
  '/youtube-playlist',
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const ref = str(req.body?.playlist, 'Playlist', { required: true, max: 500 });

    const targetPlaylistId = req.body?.targetPlaylistId
      ? id(req.body.targetPlaylistId, 'targetPlaylistId')
      : null;
    if (targetPlaylistId) await assertOwnedPlaylist(targetPlaylistId, req.user.id);

    try {
      const jobId = await startYouTubePlaylistImport(req.user.id, ref, {
        createPlaylist: bool(req.body?.createPlaylist, true),
        targetPlaylistId,
      });
      res.status(202).json({ jobId });
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

importRoutes.get(
  '/jobs',
  handler(async (req, res) => {
    const jobs = await many(
      `SELECT id, source, source_name AS "sourceName", status, total, processed,
              added, skipped, failed, error, created_at AS "createdAt",
              finished_at AS "finishedAt"
         FROM import_jobs
        WHERE user_id = $1
     ORDER BY created_at DESC
        LIMIT 25`,
      [req.user.id]
    );
    res.json({ jobs });
  })
);

importRoutes.get(
  '/jobs/:id',
  handler(async (req, res) => {
    const job = await getJob(req.user.id, id(req.params.id, 'Job id'));
    if (!job) throw notFound('Import job not found.');
    res.json(job);
  })
);

async function assertOwnedPlaylist(playlistId, userId) {
  const owned = await one('SELECT id FROM playlists WHERE id = $1 AND user_id = $2', [
    playlistId,
    userId,
  ]);
  if (!owned) throw notFound('Target playlist not found.');
}
