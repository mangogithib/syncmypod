import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import { spotifyRedirectUri } from '../providers/spotify.js';
import { many, one, query } from '../db/pool.js';
import { badRequest, bool, handler, id, notFound, str } from '../lib/api.js';
import * as spotify from '../providers/spotify.js';
import {
  getJob,
  startSpotifyPlaylistImport,
  startSpotifySavedImport,
} from '../services/import.js';

export const importRoutes = Router();

// OAuth `state` values, held in memory with a short expiry.
//
// state exists to prove the callback belongs to a request this server started -
// without it, anyone can send a user to the callback URL with their own code and
// link the wrong Spotify account. In memory rather than in Postgres because it
// is worthless after ten minutes and a restart mid-OAuth is a retry, not a bug.
const pendingStates = new Map();

function issueState(userId) {
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}

function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state); // Single use.
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

export function prunePendingStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

// ---------------------------------------------------------------------------
// Spotify account linking
// ---------------------------------------------------------------------------

importRoutes.get(
  '/spotify/status',
  requireUser,
  handler(async (req, res) => {
    const account = await one(
      `SELECT display_name AS "displayName", provider_user_id AS "providerUserId",
              scopes, linked_at AS "linkedAt", expires_at AS "expiresAt"
         FROM oauth_accounts
        WHERE user_id = $1 AND provider = 'spotify'`,
      [req.user.id]
    );
    res.json({
      // Two separate capabilities, reported separately because they fail for
      // different reasons and need different fixes.
      configured: spotify.isEnabled(),
      redirectUri: spotify.isEnabled() ? spotifyRedirectUri(req) : null,
      linked: Boolean(account),
      account,
    });
  })
);

importRoutes.get(
  '/spotify/authorize',
  requireUser,
  handler(async (req, res) => {
    if (!spotify.isEnabled()) {
      throw badRequest(
        'Spotify is not configured. Add a Client ID and Client Secret in Settings.'
      );
    }
    const state = issueState(req.user.id);
    // Returned as JSON rather than a 302 so the frontend controls the
    // navigation and can show its own error if this fails.
    res.json({ url: spotify.authorizeUrl(req, state) });
  })
);

// Spotify redirects the browser here, so this route must render a page rather
// than return JSON.
importRoutes.get(
  '/spotify/callback',
  handler(async (req, res) => {
    const { code, state, error } = req.query;

    if (error) return res.status(400).send(callbackPage(`Spotify said: ${error}`));
    if (!code || !state) {
      return res.status(400).send(callbackPage('Missing code or state.'));
    }

    // The user id comes from the state we issued, not from the session cookie.
    // SameSite=Lax lets the cookie survive this redirect, but relying on state
    // means the link cannot be pointed at the wrong account even if it did not.
    const userId = consumeState(String(state));
    if (!userId) {
      return res
        .status(400)
        .send(callbackPage('This link has expired or was already used. Try again.'));
    }

    try {
      const tokens = await spotify.exchangeCode(req, String(code));
      const me = await spotify.getMe(tokens.accessToken);

      await query(
        `INSERT INTO oauth_accounts
           (user_id, provider, provider_user_id, display_name,
            access_token, refresh_token, expires_at, scopes, linked_at)
         VALUES ($1, 'spotify', $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id, provider) DO UPDATE
            SET provider_user_id = EXCLUDED.provider_user_id,
                display_name     = EXCLUDED.display_name,
                access_token     = EXCLUDED.access_token,
                refresh_token    = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
                expires_at       = EXCLUDED.expires_at,
                scopes           = EXCLUDED.scopes,
                linked_at        = now()`,
        [
          userId,
          me.id,
          me.display_name || me.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresAt,
          tokens.scopes,
        ]
      );

      res.send(callbackPage(null, me.display_name || me.id));
    } catch (err) {
      console.error('[import] spotify callback failed:', err.message);
      res.status(502).send(callbackPage(err.message));
    }
  })
);

importRoutes.delete(
  '/spotify/link',
  requireUser,
  handler(async (req, res) => {
    await query(
      `DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = 'spotify'`,
      [req.user.id]
    );
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

importRoutes.get(
  '/spotify/playlists',
  requireUser,
  handler(async (req, res) => {
    const playlists = await spotify.getMyPlaylists(req.user.id);
    // Flags playlists already imported, so the list shows what is new.
    const imported = await many(
      `SELECT source_ref AS "sourceRef", id, name
         FROM playlists
        WHERE user_id = $1 AND source = 'spotify' AND source_ref IS NOT NULL`,
      [req.user.id]
    );
    const bySourceRef = new Map(imported.map((row) => [row.sourceRef, row]));

    res.json({
      playlists: playlists.map((playlist) => ({
        ...playlist,
        importedAs: bySourceRef.get(playlist.spotifyId) || null,
      })),
    });
  })
);

importRoutes.post(
  '/spotify/playlists/:spotifyId',
  requireUser,
  handler(async (req, res) => {
    const spotifyId = str(req.params.spotifyId, 'Playlist id', {
      required: true,
      max: 60,
    });

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

    const jobId = await startSpotifyPlaylistImport(req.user.id, spotifyId, {
      targetPlaylistId,
      createPlaylist: bool(req.body?.createPlaylist, true),
    });
    // 202: accepted and running, not finished. The client polls the job.
    res.status(202).json({ jobId });
  })
);

importRoutes.post(
  '/spotify/saved',
  requireUser,
  handler(async (req, res) => {
    const jobId = await startSpotifySavedImport(req.user.id, {
      createPlaylist: bool(req.body?.createPlaylist, false),
    });
    res.status(202).json({ jobId });
  })
);

importRoutes.get(
  '/jobs',
  requireUser,
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
  requireUser,
  handler(async (req, res) => {
    const job = await getJob(req.user.id, id(req.params.id, 'Job id'));
    if (!job) throw notFound('Import job not found.');
    res.json(job);
  })
);

// A self-contained page for the OAuth return trip. Inline rather than a template
// file because it is the one server-rendered page in the app, it must work
// before any of the frontend JavaScript has loaded, and it has to satisfy the
// app's own strict Content-Security-Policy - which is why the styling is a
// single <style> block and there is no script at all.
function callbackPage(error, accountName) {
  const safe = (text) =>
    String(text ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]
    );

  const heading = error ? 'Could not link Spotify' : 'Spotify linked';
  const message = error
    ? safe(error)
    : `Connected as <strong>${safe(accountName)}</strong>. You can close this tab and return to SyncMyPod.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} - SyncMyPod</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #1c1f23; padding: 24px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
          padding: 28px 32px; max-width: 460px; box-shadow: 0 1px 3px rgb(0 0 0 / 6%); }
  h1 { margin: 0 0 10px; font-size: 19px; letter-spacing: -0.01em; }
  p { margin: 0; color: #5a6067; }
  .bad h1 { color: #b3261e; }
  a { display: inline-block; margin-top: 20px; color: #2f6feb; text-decoration: none;
      font-weight: 500; }
  a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaed; }
    .card { background: #1e2126; border-color: #2e3238; box-shadow: none; }
    p { color: #9aa1a9; }
  }
</style>
</head>
<body>
  <div class="card${error ? ' bad' : ''}">
    <h1>${heading}</h1>
    <p>${message}</p>
    <a href="/#/import">Back to SyncMyPod</a>
  </div>
</body>
</html>`;
}
