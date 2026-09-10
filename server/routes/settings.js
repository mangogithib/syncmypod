import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { badRequest, handler } from '../lib/api.js';
import * as musicbrainz from '../providers/musicbrainz.js';
import * as spotify from '../providers/spotify.js';
import { describe, SETTING_KEYS, setMany } from '../services/app-settings.js';

export const settingsRoutes = Router();
settingsRoutes.use(requireUser);

// Instance configuration, editable from the Settings page.

settingsRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json({
      settings: describe(),
      providers: {
        spotify: spotify.isEnabled(),
        musicbrainz: musicbrainz.isEnabled(),
      },
    });
  })
);

settingsRoutes.put(
  '/',
  handler(async (req, res) => {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw badRequest('Expected a settings object.');
    }

    const unknown = Object.keys(updates).filter((key) => !SETTING_KEYS.includes(key));
    if (unknown.length > 0) {
      throw badRequest(`Unknown setting(s): ${unknown.join(', ')}`);
    }

    for (const [key, value] of Object.entries(updates)) {
      if (typeof value !== 'string') {
        throw badRequest(`${key} must be text.`);
      }
      if (value.length > 500) {
        throw badRequest(`${key} is too long.`);
      }
    }

    const result = await setMany(updates, req.user.id);

    // A rejected key is not an error - the request may legitimately have
    // touched a mix of editable and environment-locked settings - so the
    // outcome is reported per key and the UI explains it.
    res.json({
      applied: result.applied,
      rejected: result.rejected,
      settings: describe(),
      providers: {
        spotify: spotify.isEnabled(),
        musicbrainz: musicbrainz.isEnabled(),
      },
    });
  })
);

// Makes one real request to the provider and reports what came back.
//
// This exists because "configured" and "working" are different things, and the
// gap between them is where the frustrating failures live: a typo in a secret, a
// revoked key, or a provider-side restriction that has nothing to do with the
// credentials being correct. Without this, the first sign of trouble is an empty
// search result with no explanation.
settingsRoutes.post(
  '/test/:provider',
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const provider = String(req.params.provider);

    if (provider === 'spotify') {
      if (!spotify.isEnabled()) {
        return res.json({
          ok: false,
          stage: 'config',
          message: 'No Client ID and Client Secret are set.',
        });
      }
      try {
        // A search, not just a token fetch. The token endpoint and the data
        // endpoints can disagree - credentials that authenticate fine may still
        // be refused for the data API - and it is the data API that matters.
        const found = await spotify.searchAll('a', { types: 'track', limit: 1 });
        return res.json({
          ok: true,
          message: `Working. Search returned ${found.tracks.length} result(s).`,
        });
      } catch (err) {
        return res.json({
          ok: false,
          stage: 'request',
          status: err.status || null,
          message: err.message,
          // Spotify's own wording is the most useful thing to show here, but it
          // needs translating into what to actually do about it.
          hint: spotifyHint(err),
        });
      }
    }

    if (provider === 'musicbrainz') {
      if (!musicbrainz.isEnabled()) {
        return res.json({
          ok: false,
          stage: 'config',
          message: 'No contact address is set.',
        });
      }
      try {
        const found = await musicbrainz.searchArtists('Radiohead', { limit: 1 });
        return res.json({
          ok: true,
          message: `Working. Search returned ${found.length} result(s).`,
        });
      } catch (err) {
        return res.json({
          ok: false,
          stage: 'request',
          status: err.status || null,
          message: err.message,
        });
      }
    }

    throw badRequest(`Unknown provider: ${provider}`);
  })
);

function spotifyHint(err) {
  const message = String(err.message || '');
  if (/premium/i.test(message)) {
    return 'Spotify requires the account that owns the app to have an active Premium subscription before it will serve the Web API. The credentials themselves are fine.';
  }
  if (err.status === 401 || /invalid client/i.test(message)) {
    return 'The Client ID or Client Secret is wrong. Check for a stray space, and confirm the secret has not been rotated.';
  }
  if (err.status === 429) {
    return 'Rate limited. Wait a minute and try again.';
  }
  return null;
}
