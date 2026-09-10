import { Router } from 'express';
import { clientIp, rateLimit, requireUser } from '../auth/middleware.js';
import { hashPassword, validatePassword, verifyPassword } from '../auth/passwords.js';
import {
  clearCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  readCookie,
  sessionCookie,
} from '../auth/sessions.js';
import { one, query } from '../db/pool.js';
import { badRequest, handler, str } from '../lib/api.js';

export const authRoutes = Router();

// Whether the connection is really HTTPS, which decides if the session cookie
// gets the Secure flag. Marking it Secure on a plain-HTTP instance makes the
// browser drop the cookie and login silently fail, so this is checked rather
// than assumed.
function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// A fresh instance has no accounts. The UI asks this to decide between showing
// a login form and a first-run "create the owner account" form.
authRoutes.get(
  '/state',
  handler(async (req, res) => {
    const row = await one('SELECT count(*)::int AS count FROM users');
    res.json({
      needsSetup: row.count === 0,
      user: req.user
        ? {
            id: req.user.id,
            username: req.user.username,
            displayName: req.user.displayName,
            isOwner: req.user.isOwner,
          }
        : null,
    });
  })
);

// First-run account creation. Open only while the instance has no users at all -
// after that it is closed permanently, so an exposed instance cannot have a
// second owner registered against it.
authRoutes.post(
  '/setup',
  rateLimit({ windowMs: 60_000, max: 5 }),
  handler(async (req, res) => {
    const existing = await one('SELECT count(*)::int AS count FROM users');
    if (existing.count > 0) {
      throw badRequest('This instance already has an account. Sign in instead.');
    }

    const username = str(req.body?.username, 'Username', {
      required: true,
      min: 2,
      max: 60,
    });
    const password = String(req.body?.password || '');
    const passwordError = validatePassword(password);
    if (passwordError) throw badRequest(passwordError);

    const passwordHash = await hashPassword(password);
    const user = await one(
      `INSERT INTO users (username, password_hash, display_name, is_owner)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, username, display_name, is_owner`,
      [username, passwordHash, str(req.body?.displayName, 'Display name', { max: 120 })]
    );

    const { cookieValue, expiresAt } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(cookieValue, expiresAt, { secure: isSecureRequest(req) })
    );
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        isOwner: user.is_owner,
      },
    });
  })
);

authRoutes.post(
  '/login',
  // Per-IP, deliberately tight. A personal instance has no legitimate reason to
  // see ten failed logins a minute from one address.
  rateLimit({ windowMs: 60_000, max: 10 }),
  handler(async (req, res) => {
    const username = str(req.body?.username, 'Username', { required: true, max: 60 });
    const password = String(req.body?.password || '');

    const user = await one(
      `SELECT id, username, password_hash, display_name, is_owner
         FROM users WHERE lower(username) = lower($1)`,
      [username]
    );

    // Same message and a real hash comparison either way, so the response
    // neither reveals which usernames exist nor returns noticeably faster for
    // an unknown one.
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, 'scrypt$32768$8$1$AAAA$AAAA');

    if (!user || !ok) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const { cookieValue, expiresAt } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(cookieValue, expiresAt, { secure: isSecureRequest(req) })
    );
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        isOwner: user.is_owner,
      },
    });
  })
);

authRoutes.post(
  '/logout',
  handler(async (req, res) => {
    const cookie = readCookie(req);
    if (cookie) await destroySession(cookie);
    res.setHeader('Set-Cookie', clearCookie({ secure: isSecureRequest(req) }));
    res.json({ ok: true });
  })
);

authRoutes.post(
  '/password',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 5 }),
  handler(async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    const user = await one('SELECT password_hash FROM users WHERE id = $1', [
      req.user.id,
    ]);
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) throw badRequest(passwordError);

    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      req.user.id,
      await hashPassword(newPassword),
    ]);

    // Every browser session is invalidated, then a fresh one is issued to the
    // browser that made the change. A password change should log out anyone else
    // holding a session, which is the whole point of doing it.
    //
    // Device tokens are deliberately NOT revoked here: the concept's reasoning
    // is that a token and a password are independent, so changing one need not
    // break a working sync on another machine.
    await destroyAllSessions(req.user.id);
    const { cookieValue, expiresAt } = await createSession(req.user.id, {
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(cookieValue, expiresAt, { secure: isSecureRequest(req) })
    );
    res.json({ ok: true, devicesKept: true });
  })
);
