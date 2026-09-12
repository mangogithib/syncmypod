import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { badRequest, handler } from '../lib/api.js';
import * as deezer from '../providers/deezer.js';
import * as itunes from '../providers/itunes.js';
import * as musicbrainz from '../providers/musicbrainz.js';
import * as youtube from '../providers/youtube.js';
import { redirectUri } from '../services/youtube-account.js';
import { describe, SETTING_KEYS, setMany } from '../services/app-settings.js';

export const settingsRoutes = Router();
settingsRoutes.use(requireUser);

// Instance configuration, editable from the Settings page.

// One table describing every provider, rather than a chain of if-blocks. Adding
// a provider means adding a row here and nothing else in this file.
//
// `probe` is deliberately a real search rather than a reachability check - a
// provider can look healthy and still refuse the data API, and it is the data
// API that matters.
const PROVIDERS = {
  // YouTube is first because it is the one people ask about. It is not in the
  // resolver's ladder - it is the named fallback for music the catalogues do
  // not carry - but it is a provider, it has a toggle, and the Settings page
  // should say whether it is on.
  youtube: {
    label: 'YouTube',
    module: youtube,
    unconfigured: 'YouTube is switched off.',
    probe: () => youtube.searchMusic('radiohead creep', { limit: 1 }),
    count: (found) => found.length,
  },
  deezer: {
    label: 'Deezer',
    module: deezer,
    unconfigured: 'Deezer is switched off.',
    probe: () => deezer.searchAll('radiohead', { types: 'track', limit: 1 }),
    count: (found) => found.tracks.length,
  },
  itunes: {
    label: 'iTunes',
    module: itunes,
    unconfigured: 'iTunes is switched off.',
    probe: () => itunes.searchAll('radiohead', { types: 'track', limit: 1 }),
    count: (found) => found.tracks.length,
  },
  musicbrainz: {
    label: 'MusicBrainz',
    module: musicbrainz,
    unconfigured: 'No contact address is set.',
    probe: () => musicbrainz.searchArtists('Radiohead', { limit: 1 }),
    count: (found) => found.length,
  },
};

function providerStatus() {
  const status = {};
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    status[name] = provider.module.isEnabled();
  }
  return status;
}

settingsRoutes.get(
  '/',
  handler(async (req, res) => {
    // The redirect address belongs with the fields it is pasted alongside.
    // It has to match what is registered in the Google console character for
    // character, so it is shown rather than described.
    res.json({
      settings: describe(),
      providers: providerStatus(),
      youtubeRedirectUri: redirectUri(req),
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
      if (typeof value !== 'string') throw badRequest(`${key} must be text.`);
      if (value.length > 500) throw badRequest(`${key} is too long.`);
    }

    const result = await setMany(updates, req.user.id);

    // A rejected key is not an error - the request may legitimately have
    // touched a mix of editable and environment-locked settings - so the
    // outcome is reported per key and the UI explains it.
    res.json({
      applied: result.applied,
      rejected: result.rejected,
      settings: describe(),
      providers: providerStatus(),
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
  rateLimit({ windowMs: 60_000, max: 20, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const name = String(req.params.provider);
    const provider = PROVIDERS[name];
    if (!provider) throw badRequest(`Unknown provider: ${name}`);

    if (!provider.module.isEnabled()) {
      return res.json({ ok: false, stage: 'config', message: provider.unconfigured });
    }

    try {
      const found = await provider.probe();
      const count = provider.count(found);
      return res.json({
        ok: true,
        message: `Working. Search returned ${count} result(s).`,
      });
    } catch (err) {
      return res.json({
        ok: false,
        stage: 'request',
        status: err.status || null,
        message: err.message,
        hint: provider.hint ? provider.hint(err) : null,
      });
    }
  })
);

