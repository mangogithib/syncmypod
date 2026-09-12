import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { badRequest, bool, handler, id, notFound, str } from '../lib/api.js';
import {
  addSource,
  checkDueSources,
  checkSource,
  listSources,
  removeSource,
  setEnabled,
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
    try {
      res.status(201).json({ source: await addSource(req.user.id, url) });
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
    const changed = await setEnabled(
      req.user.id,
      id(req.params.id, 'Source id'),
      bool(req.body?.enabled, true)
    );
    if (!changed) throw notFound('Source not found.');
    res.json({ ok: true });
  })
);

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
