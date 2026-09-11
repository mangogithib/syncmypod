import { Router } from 'express';
import { clientIp, rateLimit, requireUser } from '../auth/middleware.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  claimPairingCode,
  createDeviceToken,
  createPairingCode,
  revokeDevice,
} from '../auth/tokens.js';
import { baseUrl } from '../config.js';
import { many, one } from '../db/pool.js';
import { handler, id, notFound, str } from '../lib/api.js';

export const deviceRoutes = Router();

// ---------------------------------------------------------------------------
// Browser-facing: managing paired computers
// ---------------------------------------------------------------------------

deviceRoutes.get(
  '/',
  requireUser,
  handler(async (req, res) => {
    const devices = await many(
      `SELECT d.id,
              d.name,
              d.token_prefix   AS "tokenPrefix",
              d.created_at     AS "createdAt",
              d.last_seen_at   AS "lastSeenAt",
              d.last_seen_ip   AS "lastSeenIp",
              d.platform,
              d.app_version    AS "appVersion",
              d.ipod_name      AS "ipodName",
              d.ipod_model     AS "ipodModel",
              d.ipod_generation AS "ipodGeneration",
              d.ipod_capacity_bytes AS "ipodCapacityBytes",
              d.ipod_free_bytes     AS "ipodFreeBytes",
              (SELECT count(*)::int FROM device_tracks dt
                WHERE dt.device_id = d.id AND dt.state = 'synced') AS "syncedTracks",
              (SELECT max(started_at) FROM sync_runs sr WHERE sr.device_id = d.id)
                AS "lastSyncAt"
         FROM devices d
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
     ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json({ devices, serverUrl: baseUrl(req) });
  })
);

// Issues a pairing code for the local app to redeem.
//
// The preferred way to link a computer: the user reads an eight-character code
// off the web UI instead of typing account credentials into a desktop app.
deviceRoutes.post(
  '/pair',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 10, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const { code, expiresAt } = await createPairingCode(req.user.id);
    res.json({
      code,
      expiresAt,
      // The local app needs both halves to connect, so they are handed over
      // together rather than leaving the user to find their own server address.
      serverUrl: baseUrl(req),
      expiresInSeconds: Math.round((expiresAt.getTime() - Date.now()) / 1000),
    });
  })
);

deviceRoutes.delete(
  '/:id',
  requireUser,
  handler(async (req, res) => {
    const revoked = await revokeDevice(req.user.id, id(req.params.id, 'Device id'));
    if (!revoked) throw notFound('Device not found.');
    // Revoked rather than deleted, so its sync history stays readable and the
    // token hash can never be reissued.
    res.json({ ok: true });
  })
);

deviceRoutes.get(
  '/:id/history',
  requireUser,
  handler(async (req, res) => {
    const deviceId = id(req.params.id, 'Device id');
    const device = await one(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    if (!device) throw notFound('Device not found.');

    const runs = await many(
      `SELECT id, started_at AS "startedAt", finished_at AS "finishedAt",
              status, stats, message
         FROM sync_runs
        WHERE device_id = $1
     ORDER BY started_at DESC
        LIMIT 50`,
      [deviceId]
    );
    res.json({ runs });
  })
);

// ---------------------------------------------------------------------------
// Local-app facing: redeeming a pairing code or credentials for a token
// ---------------------------------------------------------------------------
//
// These two are the only unauthenticated write endpoints in the app, so both are
// rate limited per IP. An eight-character code from a 32-symbol alphabet is
// about 40 bits; the limiter plus the ten-minute expiry is what makes guessing
// one impractical.

deviceRoutes.post(
  '/claim',
  rateLimit({ windowMs: 60_000, max: 10 }),
  handler(async (req, res) => {
    const code = str(req.body?.code, 'Code', { required: true, max: 32 });
    const name = str(req.body?.deviceName, 'Device name', { max: 120 }) || 'Local app';

    const claimed = await claimPairingCode(code, name, {
      platform: str(req.body?.platform, 'Platform', { max: 60 }),
      appVersion: str(req.body?.appVersion, 'App version', { max: 40 }),
    });
    if (!claimed) {
      return res
        .status(400)
        .json({ error: 'That code is not valid, has expired, or was already used.' });
    }

    res.json({
      token: claimed.token,
      device: { id: claimed.device.id, name: claimed.device.name },
      // Echoed back so the local app can store a canonical server URL rather
      // than whatever the user typed.
      serverUrl: baseUrl(req),
    });
  })
);

// The credentials route from the concept, kept as a fallback for headless setups
// where reading a code off a web page is awkward. The password is used once and
// never stored by the local app.
deviceRoutes.post(
  '/token',
  rateLimit({ windowMs: 60_000, max: 10 }),
  handler(async (req, res) => {
    const username = str(req.body?.username, 'Username', { required: true, max: 60 });
    const password = String(req.body?.password || '');
    const name = str(req.body?.deviceName, 'Device name', { max: 120 }) || 'Local app';

    const user = await one(
      'SELECT id, password_hash FROM users WHERE lower(username) = lower($1)',
      [username]
    );
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, 'scrypt$32768$8$1$AAAA$AAAA');

    if (!user || !ok) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    const { device, token } = await createDeviceToken(user.id, name, {
      platform: str(req.body?.platform, 'Platform', { max: 60 }),
      appVersion: str(req.body?.appVersion, 'App version', { max: 40 }),
    });

    console.log(
      `[devices] token issued for user ${user.id} device "${device.name}" from ${clientIp(req)}`
    );

    res.json({
      token,
      device: { id: device.id, name: device.name },
      serverUrl: baseUrl(req),
    });
  })
);
