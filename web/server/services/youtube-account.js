import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { get } from './app-settings.js';

// A YouTube account connected to this server, read-only.
//
// What this is for: keeping a library here in step with a library over there.
// Connect the account once, tick the playlists worth following, and they are
// re-checked whenever the app is opened. New songs in a followed playlist
// arrive here without anyone pasting a link.
//
// **This is not the local app's YouTube sign-in.** That one lives on the user's
// own machine, is made of the browser's own cookies, and exists to get the
// higher-quality audio stream a Premium subscription is entitled to. This one
// is an OAuth grant held by the server that can read playlists and do nothing
// else - it cannot download, cannot post, cannot see anything private beyond
// the playlist list. Keeping them apart is the point: neither can stand in for
// the other, and revoking one leaves the other working.
//
// ── Why this needs setting up and the rest of the app does not ──────────────
//
// Everything else here works with no account and no key, and that is a
// deliberate property of the project. This is the exception, and it is not one
// that can be engineered away: reading somebody's own playlists requires their
// permission, permission requires OAuth, and Google issues OAuth credentials
// only to a registered application. There is no key that could be shipped -
// a client secret in a public repository is not a secret, and Google revokes
// the ones it finds.
//
// So the instance owner registers their own client, once, and every user of
// that instance connects through it. The Settings page carries the steps and
// the exact redirect URI to paste. Until that is done, the feature reports
// itself as unconfigured rather than broken.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';

// Read-only, and only YouTube. The narrowest scope that can list a user's
// playlists and their contents. Notably NOT youtube.force-ssl, which would also
// allow writing - this app has no reason to modify anything in the account, and
// asking for a permission it will never use is how a consent screen ends up
// looking alarming enough to refuse.
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function credentials() {
  return {
    clientId: get('google.client_id'),
    clientSecret: get('google.client_secret'),
  };
}

export function isConfigured() {
  const { clientId, clientSecret } = credentials();
  return Boolean(clientId && clientSecret);
}

// The address Google sends the user back to. It has to match what is registered
// in the Google Cloud console character for character, which is why the UI
// shows it rather than describing it.
export function redirectUri(req) {
  return `${publicBase(req)}/api/youtube-account/callback`;
}

function publicBase(req) {
  const configured = (config.publicUrl || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  // Falling back to the request's own idea of the host is fine for a test
  // instance; a real deployment sets PUBLIC_URL, and Google will reject a
  // redirect that does not match the registered one anyway.
  const proto = req?.protocol || 'http';
  const host = req?.get?.('host') || 'localhost';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------
//
// A refresh token is a standing permission to read somebody's account. It
// should not be sitting in plain text in a table that ends up in a backup, a
// `pg_dump` in a home directory, or a screenshot of a database client.
//
// AES-256-GCM under a key derived from SESSION_SECRET. That means rotating the
// session secret invalidates stored grants - which is correct, since rotating
// it is what you do after a compromise, and a compromised secret is exactly
// when these should stop working. A grant that cannot be decrypted is reported
// as disconnected and the user reconnects; nothing breaks and nothing is
// silently wrong.

const key = createHash('sha256')
  .update(`youtube-account:${config.sessionSecret || 'unset'}`)
  .digest();

function seal(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function open(sealed) {
  if (!sealed) return null;
  try {
    const [version, iv, tag, body] = String(sealed).split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or a tampered row. Either way there is no usable token here.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The connect flow
// ---------------------------------------------------------------------------

// Pending authorisations, keyed by the state parameter. In memory because they
// live for the seconds between leaving for Google and coming back, and a
// restart in that window means the user presses Connect again.
const pending = new Map();
const STATE_TTL_MS = 10 * 60_000;

export function beginConnect(userId, req) {
  if (!isConfigured()) {
    throw new Error(
      'No Google client is set up for this instance yet. An administrator adds one in Settings.'
    );
  }

  sweepPending();
  const state = randomBytes(24).toString('base64url');
  pending.set(state, { userId, at: Date.now(), redirect: redirectUri(req) });

  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', credentials().clientId);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  // Offline access is what produces a refresh token, and a refresh token is
  // what "stays signed in" means. Without it the grant lasts an hour.
  url.searchParams.set('access_type', 'offline');
  // Google issues a refresh token only on the FIRST consent for a given client
  // and account. Someone reconnecting after a disconnect would otherwise get an
  // access token and no refresh token, and appear to connect successfully then
  // stop working an hour later. Forcing the prompt makes reconnecting reliable.
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function sweepPending() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pending) if (entry.at < cutoff) pending.delete(state);
}

// Exchanges the code Google sent back for tokens, and stores the grant.
export async function completeConnect(state, code) {
  sweepPending();
  const entry = takeState(state);
  if (!entry) {
    throw new Error('That sign-in link has expired. Press Connect again.');
  }

  const { clientId, clientSecret } = credentials();
  const tokens = await postForm(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: entry.redirect,
    grant_type: 'authorization_code',
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a long-lived token, so the connection would stop working within the hour. Remove SyncMyPod from your Google account permissions and try again.'
    );
  }

  const channel = await fetchChannel(tokens.access_token).catch(() => null);

  await query(
    `INSERT INTO youtube_accounts
       (user_id, channel_id, channel_title, refresh_token, access_token, access_expires, scopes)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7)
     ON CONFLICT (user_id) DO UPDATE
        SET channel_id = EXCLUDED.channel_id,
            channel_title = EXCLUDED.channel_title,
            refresh_token = EXCLUDED.refresh_token,
            access_token = EXCLUDED.access_token,
            access_expires = EXCLUDED.access_expires,
            scopes = EXCLUDED.scopes,
            connected_at = now(),
            last_error = NULL`,
    [
      entry.userId,
      channel?.id || null,
      channel?.title || null,
      seal(tokens.refresh_token),
      seal(tokens.access_token),
      String(Math.max(60, Number(tokens.expires_in) || 3600)),
      tokens.scope || SCOPE,
    ]
  );

  return { userId: entry.userId, channelTitle: channel?.title || null };
}

// Constant-time lookup, so the state parameter cannot be probed a byte at a
// time. It is a CSRF token: whoever presents it is claimed to be the person who
// pressed Connect.
function takeState(state) {
  const given = Buffer.from(String(state || ''));
  for (const [candidate, entry] of pending) {
    const known = Buffer.from(candidate);
    if (known.length === given.length && timingSafeEqual(known, given)) {
      pending.delete(candidate);
      return entry;
    }
  }
  return null;
}

export async function disconnect(userId) {
  const account = await one('SELECT refresh_token FROM youtube_accounts WHERE user_id = $1', [
    userId,
  ]);
  if (!account) return false;

  // Tell Google as well as forgetting locally. Deleting the row alone leaves a
  // live grant sitting in the user's Google account that they did not ask to
  // keep, and which this app can no longer show them.
  const token = open(account.refresh_token);
  if (token) {
    await postForm(REVOKE_URL, { token }).catch(() => {
      // Already revoked, or Google is unreachable. The local row still goes.
    });
  }

  await query('DELETE FROM youtube_accounts WHERE user_id = $1', [userId]);
  await query('DELETE FROM youtube_playlists WHERE user_id = $1', [userId]);
  return true;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// A usable access token, refreshed if the cached one is spent.
async function accessToken(userId) {
  const account = await one(
    `SELECT refresh_token, access_token,
            (access_expires > now() + interval '60 seconds') AS fresh
       FROM youtube_accounts WHERE user_id = $1`,
    [userId]
  );
  if (!account) throw new AccountError('No YouTube account is connected.');

  if (account.fresh) {
    const cached = open(account.access_token);
    if (cached) return cached;
  }

  const refresh = open(account.refresh_token);
  if (!refresh) {
    throw new AccountError(
      'The stored connection could not be read, which happens if the server session secret changed. Connect the account again.'
    );
  }

  const { clientId, clientSecret } = credentials();
  let tokens;
  try {
    tokens = await postForm(TOKEN_URL, {
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // A refresh that fails with invalid_grant means the user revoked access, or
    // changed their password. That is not a transient error and retrying will
    // never help, so the grant is dropped and the UI asks them to reconnect.
    if (/invalid_grant/i.test(err.message)) {
      await query(
        `UPDATE youtube_accounts SET last_error = $2 WHERE user_id = $1`,
        [userId, 'Access was revoked in your Google account. Connect again to resume.']
      );
      throw new AccountError(
        'Access to this YouTube account was revoked. Connect it again to resume syncing.'
      );
    }
    throw err;
  }

  await query(
    `UPDATE youtube_accounts
        SET access_token = $2,
            access_expires = now() + ($3 || ' seconds')::interval,
            last_error = NULL
      WHERE user_id = $1`,
    [userId, seal(tokens.access_token), String(Math.max(60, Number(tokens.expires_in) || 3600))]
  );

  return tokens.access_token;
}

export class AccountError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Reading the account
// ---------------------------------------------------------------------------

export async function status(userId) {
  const account = await one(
    `SELECT channel_title AS "channelTitle", connected_at AS "connectedAt",
            last_synced_at AS "lastSyncedAt", last_error AS "lastError"
       FROM youtube_accounts WHERE user_id = $1`,
    [userId]
  );

  return {
    configured: isConfigured(),
    connected: Boolean(account),
    account: account || null,
  };
}

export async function listPlaylists(userId) {
  const { rows } = await query(
    `SELECT youtube_id AS "youtubeId", title, item_count AS "itemCount",
            thumbnail_url AS "thumbnailUrl", selected,
            target_playlist_id AS "targetPlaylistId",
            last_synced_at AS "lastSyncedAt"
       FROM youtube_playlists
      WHERE user_id = $1
   ORDER BY selected DESC, (youtube_id = 'LL') DESC, lower(title)`,
    [userId]
  );
  return rows;
}

// Which playlists to follow. Replaces the whole selection, because that is what
// a set of checkboxes means when the form is submitted.
export async function setSelection(userId, youtubeIds) {
  const wanted = [...new Set((youtubeIds || []).map(String))];
  await query(`UPDATE youtube_playlists SET selected = (youtube_id = ANY($2::text[])) WHERE user_id = $1`, [
    userId,
    wanted,
  ]);
  return listPlaylists(userId);
}

// Everything in one playlist, as track descriptions for the resolver.
export async function playlistItems(userId, youtubeId, { maxTracks = 1000 } = {}) {
  const token = await accessToken(userId);
  const out = [];
  let pageToken;
  let pages = 0;

  do {
    const page = await apiGet(token, 'playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: youtubeId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of page.items || []) {
      const snippet = item.snippet || {};
      const title = snippet.title || '';
      // Videos removed or made private keep a row in the playlist with these
      // exact titles and no usable metadata. They are not songs.
      if (!title || title === 'Deleted video' || title === 'Private video') continue;

      out.push({
        videoId: item.contentDetails?.videoId || snippet.resourceId?.videoId || null,
        title,
        // videoOwnerChannelTitle is the uploader; snippet.channelTitle on a
        // playlist item is the playlist's owner, which is not what is wanted.
        channel: snippet.videoOwnerChannelTitle || '',
      });
      if (out.length >= maxTracks) return out;
    }

    pageToken = page.nextPageToken;
  } while (pageToken && ++pages < 40);

  return out;
}

export async function markSynced(userId, youtubeId, { itemCount, targetPlaylistId } = {}) {
  await query(
    `UPDATE youtube_playlists
        SET last_synced_at = now(),
            last_item_count = COALESCE($3, last_item_count),
            target_playlist_id = COALESCE($4, target_playlist_id)
      WHERE user_id = $1 AND youtube_id = $2`,
    [userId, youtubeId, itemCount ?? null, targetPlaylistId ?? null]
  );
  await query('UPDATE youtube_accounts SET last_synced_at = now() WHERE user_id = $1', [userId]);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function apiGet(token, path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Quota is the one failure worth naming, because it is not a fault and it
    // clears on its own at midnight Pacific - which is not guessable from
    // "403 Forbidden".
    if (/quotaExceeded/.test(detail)) {
      throw new AccountError(
        "This instance's daily YouTube API quota is used up. It resets at 08:00 UTC.",
        { status: 429 }
      );
    }
    throw new AccountError(`YouTube returned ${response.status}.`, { status: 502 });
  }

  return response.json();
}

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // Google's error bodies are JSON and genuinely informative, unlike the
    // status code on its own. Passing the detail through saves a round of
    // "it says 400" when the real answer is "redirect_uri_mismatch".
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error_description || parsed.error || detail;
    } catch {
      // Not JSON. The truncated body is still the best information available.
    }
    throw new Error(`Google refused the request: ${detail}`);
  }

  return text ? JSON.parse(text) : {};
}

async function fetchChannel(token) {
  const data = await apiGet(token, 'channels', { part: 'snippet', mine: 'true' });
  const channel = data.items?.[0];
  return channel ? { id: channel.id, title: channel.snippet?.title || null } : null;
}
