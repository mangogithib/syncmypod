import { createHash, randomBytes, randomInt } from 'node:crypto';
import { one, query } from '../db/pool.js';

// Device tokens: how one installation of the local sync app authenticates.
//
// The design point from the concept is that the password never lives on the
// machine with the iPod plugged in. So the local app trades credentials (or a
// short pairing code) for a long-lived bearer token exactly once, and only the
// token is stored on disk from then on. A lost laptop is a revoked token, not a
// password reset.

const TOKEN_PREFIX = 'smp_';

function hashToken(token) {
  // A plain SHA-256 rather than scrypt, deliberately. Token hashing does not
  // need to be slow: the token is 256 bits of randomness, so there is no
  // dictionary to attack, and every authenticated request from the local app
  // would otherwise pay a ~100ms KDF cost.
  return createHash('sha256').update(token).digest('hex');
}

export async function createDeviceToken(userId, name, meta = {}) {
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;

  const device = await one(
    `INSERT INTO devices (user_id, name, token_hash, token_prefix, platform, app_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, token_prefix, created_at`,
    [
      userId,
      name.slice(0, 120),
      hashToken(token),
      token.slice(0, TOKEN_PREFIX.length + 6),
      meta.platform || null,
      meta.appVersion || null,
    ]
  );

  // Returned once and never retrievable again - the database holds only the
  // hash. The UI must make that clear at the point of creation.
  return { device, token };
}

export async function authenticateToken(token, { ip } = {}) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;

  const device = await one(
    `SELECT d.id       AS device_id,
            d.name     AS device_name,
            d.user_id,
            d.ipod_generation,
            u.username
       FROM devices d
       JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
    [hashToken(token)]
  );
  if (!device) return null;

  // Fire-and-forget: a failed "last seen" update must never fail the request
  // the local app was actually making.
  query(
    'UPDATE devices SET last_seen_at = now(), last_seen_ip = $2 WHERE id = $1',
    [device.device_id, ip || null]
  ).catch((err) => console.error('[tokens] last_seen update failed:', err.message));

  return device;
}

export async function revokeDevice(userId, deviceId) {
  const { rowCount } = await query(
    `UPDATE devices SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId]
  );
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------
//
// Typing a password into a desktop app is exactly the habit this design is meant
// to avoid, so the preferred flow is: the web UI shows a short code, the user
// types it into the local app, and the local app exchanges it for a token.
//
// Short codes are guessable by brute force, which is why they last minutes, are
// single-use, and are drawn from an alphabet with no 0/O or 1/I to read wrong.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export async function createPairingCode(userId) {
  // Only one live code per user: a fresh one invalidates the last, so an
  // abandoned code cannot be claimed later by someone who saw the screen.
  await query(
    'DELETE FROM pairing_codes WHERE user_id = $1 AND claimed_at IS NULL',
    [userId]
  );

  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await query(
        'INSERT INTO pairing_codes (code, user_id, expires_at) VALUES ($1, $2, $3)',
        [code, userId, expiresAt]
      );
      return { code, expiresAt };
    } catch (err) {
      // 23505 = unique violation. Astronomically unlikely, but a collision
      // should retry rather than surface as an error to the user.
      if (err.code !== '23505') throw err;
    }
  }
  throw new Error('Could not allocate a pairing code. Try again.');
}

export async function claimPairingCode(code, deviceName, meta = {}) {
  const normalised = String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');

  const row = await one(
    `UPDATE pairing_codes
        SET claimed_at = now()
      WHERE code = $1 AND claimed_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [normalised]
  );
  // A single conditional UPDATE, not a SELECT then an UPDATE: two local apps
  // racing on the same code must not both come away with a token.
  if (!row) return null;

  const { device, token } = await createDeviceToken(row.user_id, deviceName, meta);
  await query('UPDATE pairing_codes SET device_id = $2 WHERE code = $1', [
    normalised,
    device.id,
  ]);
  return { token, device, userId: row.user_id };
}

export async function prunePairingCodes() {
  const { rowCount } = await query(
    `DELETE FROM pairing_codes
      WHERE expires_at < now() - interval '1 day'`
  );
  return rowCount;
}
