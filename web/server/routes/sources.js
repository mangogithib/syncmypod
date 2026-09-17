import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { one } from '../db/pool.js';
import { badRequest, bool, handler, id, notFound, str } from '../lib/api.js';
import {
  addSource,
  checkDueSources,
  checkSource,
  listSources,
  removeSource,
  setEnabled,
  setTargetPlaylist,
  SOURCE_KINDS,
} from '../services/sources.js';

export const sourceRoutes = Router();
sourceRoutes.use(requireUser);

// Standing sources: playlists elsewhere that this library follows.
//
// Distinct from /api/import, which is one-off. An import is a thing you did; a
// source is a thing that keeps happening.

sourceRoutes.get(
  '/',
  handler(async (req, res) => {
    // Opening the page is what makes a source current, which is what "follows"
    // means. Not awaited: the list must render from what is already stored
    // whether or not YouTube is answering quickly, and anything new shows up on
    // the next load or when the page is refreshed.
    checkDueSources(req.user.id).catch((err) =>
      console.error('[sources] background check failed:', err.message)
    );

    res.json({ sources: await listSources(req.user.id), kinds: SOURCE_KINDS });
  })
);

sourceRoutes.post(
  '/',
  // Adding one reads the whole playlist, so it is a heavier call than it looks.
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const url = str(req.body?.url, 'Playlist link', { required: true, max: 500 });

    // Where its songs should land. Left out, a source makes a playlist named
    // after itself; named, everything it ever brings is appended to one that
    // already exists. The second is what "keep this playlist of mine in step
    // with that one" actually means, and there was no way to ask for it.
    const targetPlaylistId = req.body?.targetPlaylistId
      ? id(req.body.targetPlaylistId, 'targetPlaylistId')
      : null;
    if (targetPlaylistId) await assertOwnedPlaylist(targetPlaylistId, req.user.id);

    try {
      res.status(201).json({
        source: await addSource(req.user.id, url, { targetPlaylistId }),
      });
    } catch (err) {
      // A bad link is the user's to correct, not a server fault.
      throw badRequest(err.message);
    }
  })
);

sourceRoutes.post(
  '/:id/check',
  rateLimit({ windowMs: 60_000, max: 20, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const result = await checkSource(req.user.id, id(req.params.id, 'Source id'));
    if (!result) throw notFound('That source is not being followed.');
    res.json(result);
  })
);

sourceRoutes.patch(
  '/:id',
  handler(async (req, res) => {
    const sourceId = id(req.params.id, 'Source id');

    // Two independent fields, each applied only when it is actually in the
    // body. Sending one must not reset the other, which is what a single
    // "update everything from the payload" statement would do to a client that
    // only meant to pause a source.
    let touched = false;

    if (req.body?.enabled !== undefined) {
      if (!(await setEnabled(req.user.id, sourceId, bool(req.body.enabled, true)))) {
        throw notFound('Source not found.');
      }
      touched = true;
    }

    if (req.body?.targetPlaylistId !== undefined) {
      const targetPlaylistId =
        req.body.targetPlaylistId === null || req.body.targetPlaylistId === ''
          ? null
          : id(req.body.targetPlaylistId, 'targetPlaylistId');
      if (targetPlaylistId) await assertOwnedPlaylist(targetPlaylistId, req.user.id);
      if (!(await setTargetPlaylist(req.user.id, sourceId, targetPlaylistId))) {
        throw notFound('Source not found.');
      }
      touched = true;
    }

    if (!touched) throw badRequest('Nothing to change.');
    res.json({ ok: true });
  })
);

async function assertOwnedPlaylist(playlistId, userId) {
  const owned = await one('SELECT id FROM playlists WHERE id = $1 AND user_id = $2', [
    playlistId,
    userId,
  ]);
  if (!owned) throw notFound('Playlist not found.');
}

sourceRoutes.delete(
  '/:id',
  handler(async (req, res) => {
    const removed = await removeSource(req.user.id, id(req.params.id, 'Source id'));
    if (!removed) throw notFound('Source not found.');
    // Said plainly because it is the question anyone deleting a source has:
    // stopping following something does not take back what it already brought.
    res.json({ removed: true, keptImportedTracks: true });
  })
);
