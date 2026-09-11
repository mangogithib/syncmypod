import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';

// Browser sessions.
//
// The session id is random and stored in Postgres; the cookie carries that id
// plus an HMAC of it. The HMAC is not what makes the session secure - the id is
// already 256 bits of randomness - it just means a tampered or truncated cookie
// is rejected without a database round trip.

const COOKIE = config.session.cookieName;

function sign(sessionId) {
  return createHmac('sha256', config.sessionSecret)
    .update(sessionId)
    .digest('base64url');
}

function encode(sessionId) {
  return `${sessionId}.${sign(sessionId)}`;
}

function decode(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const sessionId = value.slice(0, dot);
  const provided = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(sessionId));
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return sessionId;
}

export async function createSession(userId, { userAgent, ip } = {}) {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + config.session.ttlDays * 24 * 60 * 60 * 1000
  );
  await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, expiresAt, (userAgent || '').slice(0, 400), ip || null]
  );
  return { sessionId, cookieValue: encode(sessionId), expiresAt };
}

export async function loadSession(cookieValue) {
  const sessionId = decode(cookieValue);
  if (!sessionId) return null;

  const row = await one(
    `SELECT s.id          AS session_id,
            s.expires_at,
            u.id          AS user_id,
            u.username,
            u.display_name,
            u.is_owner
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]
  );
  return row;
}

export async function destroySession(cookieValue) {
  const sessionId = decode(cookieValue);
  if (!sessionId) return;
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function destroyAllSessions(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Expired rows are already ignored by every read, so this is housekeeping
// rather than a security boundary. Called on a timer from index.js.
export async function pruneExpiredSessions() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < now()');
  return rowCount;
}

export function sessionCookie(cookieValue, expiresAt, { secure }) {
  const parts = [
    `${COOKIE}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: Strict would drop the cookie when returning from
    // an external OAuth redirect, logging the user out mid-flow.
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  // Only mark Secure when the connection actually is HTTPS. Setting it on a
  // plain-HTTP test instance means the browser silently discards the cookie and
  // login appears to do nothing.
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure }) {
  const parts = [
    `${COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Minimal cookie parsing, to avoid a dependency for one header. Only this app's
// own cookie is ever read, so exotic quoting rules do not arise.
export function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
