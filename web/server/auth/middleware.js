import { loadSession, readCookie } from './sessions.js';
import { authenticateToken } from './tokens.js';

// Attaches req.user when a valid session cookie is present, without rejecting
// anything. Routes that need a user use requireUser below; routes that merely
// behave differently when logged in (the bootstrap check, for instance) read
// req.user directly.
export async function attachSession(req, _res, next) {
  try {
    const cookie = readCookie(req);
    if (cookie) {
      const session = await loadSession(cookie);
      if (session) {
        req.user = {
          id: session.user_id,
          username: session.username,
          displayName: session.display_name,
          isOwner: session.is_owner,
        };
        req.sessionId = session.session_id;
      }
    }
  } catch (err) {
    // A database hiccup here should not turn every page into a 500; the request
    // simply continues unauthenticated and hits the login redirect.
    console.error('[auth] session load failed:', err.message);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  next();
}

// The device API is authenticated by bearer token only - never by a browser
// session. Keeping the two paths separate means a CSRF against the web UI cannot
// reach a sync endpoint, and a leaked device token cannot be used to change the
// account password.
export async function requireDevice(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return res
      .status(401)
      .json({ error: 'Missing bearer token. Pair this device first.' });
  }

  try {
    const device = await authenticateToken(match[1], { ip: clientIp(req) });
    if (!device) {
      return res
        .status(401)
        .json({ error: 'Token is not valid or has been revoked.' });
    }
    req.device = {
      id: device.device_id,
      name: device.device_name,
      userId: device.user_id,
      ipodGeneration: device.ipod_generation,
    };
    req.user = { id: device.user_id, username: device.username };
    next();
  } catch (err) {
    console.error('[auth] token check failed:', err.message);
    res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }
}

export function clientIp(req) {
  // req.ip already honours the trust proxy setting Express was configured with,
  // so there is no need to read X-Forwarded-For directly (and no risk of
  // trusting it when the app is exposed without a proxy).
  return req.ip || null;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
//
// In-memory and per-process, which is the right trade for a single-container
// self-hosted app: no Redis, no extra dependency. It exists to make credential
// stuffing and pairing-code guessing impractical, not to be a traffic shaper.

const buckets = new Map();

export function rateLimit({ windowMs, max, key = clientIp }) {
  return (req, res, next) => {
    const bucketKey = `${req.route?.path || req.path}:${key(req) || 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${retryAfter} seconds.`,
      });
    }
    next();
  };
}

// Without this the map grows one entry per distinct client forever. Called on a
// timer from index.js.
export function pruneRateLimitBuckets() {
  const now = Date.now();
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
      removed++;
    }
  }
  return removed;
}
