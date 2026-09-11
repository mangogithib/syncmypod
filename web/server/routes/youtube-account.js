import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { badRequest, handler } from '../lib/api.js';
import { startYouTubeAccountSync, syncYouTubeAccountIfStale } from '../services/import.js';
import * as account from '../services/youtube-account.js';

export const youtubeAccountRoutes = Router();

// Connecting a YouTube account to this server, and choosing what to follow.
//
// The callback is the one route here that is not an API call - Google redirects
// a browser to it, so it answers with a page rather than JSON, and it is the
// only route that cannot require a logged-in session up front (the redirect
// arrives with Google's parameters, not the app's). Its own `state` parameter
// carries the identity instead, which is what makes it safe.

youtubeAccountRoutes.get(
  '/callback',
  handler(async (req, res) => {
    // Google reports a refusal here rather than by failing the request, so a
    // user who pressed Cancel lands on this route with an error in the query.
    if (req.query.error) {
      return res.type('html').send(closingPage(false, describeGoogleError(req.query.error)));
    }

    try {
      const { channelTitle } = await account.completeConnect(
        String(req.query.state || ''),
        String(req.query.code || '')
      );
      res.type('html').send(closingPage(true, channelTitle));
    } catch (err) {
      res.type('html').send(closingPage(false, err.message));
    }
  })
);

// Everything below is the logged-in user acting on their own account.
youtubeAccountRoutes.use(requireUser);

youtubeAccountRoutes.get(
  '/',
  handler(async (req, res) => {
    const state = await account.status(req.user.id);
    const playlists = state.connected ? await account.listPlaylists(req.user.id) : [];

    // Opening the page is what triggers a sync, which is what "syncs when you
    // open the web app" means. Deliberately not awaited: the page must render
    // immediately whether or not YouTube is answering quickly, and the job
    // shows up in the import history like any other.
    if (state.connected && playlists.some((p) => p.selected)) {
      syncYouTubeAccountIfStale(req.user.id).catch(() => {});
    }

    res.json({
      ...state,
      playlists,
      // Shown so it can be copied into the Google console, which needs it
      // character for character.
      redirectUri: account.redirectUri(req),
    });
  })
);

youtubeAccountRoutes.post(
  '/connect',
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    try {
      res.json({ url: account.beginConnect(req.user.id, req) });
    } catch (err) {
      throw badRequest(err.message);
    }
  })
);

youtubeAccountRoutes.post(
  '/disconnect',
  handler(async (req, res) => {
    res.json({ disconnected: await account.disconnect(req.user.id) });
  })
);

// Re-reads the playlist list from YouTube. Separate from GET / because it costs
// API quota, so it happens when asked rather than on every page load.
youtubeAccountRoutes.post(
  '/refresh',
  rateLimit({ windowMs: 60_000, max: 6, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    try {
      res.json({ playlists: await account.refreshPlaylists(req.user.id) });
    } catch (err) {
      throw asHttp(err);
    }
  })
);

youtubeAccountRoutes.put(
  '/selection',
  handler(async (req, res) => {
    const ids = Array.isArray(req.body?.playlistIds) ? req.body.playlistIds : null;
    if (!ids) throw badRequest('Expected a list of playlist ids.');
    if (ids.length > 200) throw badRequest('That is more playlists than can be followed at once.');
    res.json({ playlists: await account.setSelection(req.user.id, ids) });
  })
);

youtubeAccountRoutes.post(
  '/sync',
  rateLimit({ windowMs: 60_000, max: 6, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    try {
      res.status(202).json({ jobId: await startYouTubeAccountSync(req.user.id) });
    } catch (err) {
      throw asHttp(err);
    }
  })
);

function asHttp(err) {
  if (err?.name === 'AccountError') {
    const wrapped = new Error(err.message);
    wrapped.status = err.status || 400;
    wrapped.expose = true;
    return wrapped;
  }
  return badRequest(err.message);
}

function describeGoogleError(code) {
  return String(code) === 'access_denied'
    ? 'You did not grant access, so nothing was connected.'
    : `Google reported: ${String(code).slice(0, 120)}`;
}

// The page Google's redirect lands on.
//
// Standalone HTML rather than a route in the app, because this document is
// opened in a popup and its only job is to tell the opener what happened and
// close itself. Everything in it is either a fixed string or escaped, so a
// message echoed from Google cannot inject markup.
function closingPage(ok, detail) {
  const heading = ok ? 'YouTube account connected' : 'Could not connect';
  const body = ok
    ? detail
      ? `Signed in as ${detail}. You can close this window.`
      : 'You can close this window.'
    : detail || 'Something went wrong. Try again from the Import page.';

  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(heading)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: #f6f7f9; color: #16181d; }
  main { max-width: 24rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #5a6172; }
  .mark { font-size: 2rem; line-height: 1; margin-bottom: .75rem; }
</style>
<main>
  <div class="mark">${ok ? '&#10003;' : '&#10007;'}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(body)}</p>
</main>
<script>
  try { window.opener && window.opener.postMessage(
    { source: 'syncmypod-youtube', ok: ${ok ? 'true' : 'false'} }, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 1200 : 6000});
</script>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}
