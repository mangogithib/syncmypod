import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// scrypt from Node's own crypto, rather than bcrypt or argon2 from npm.
//
// Both of those are native modules, which means a compiler in the Docker build
// and a real chance of an arm64 prebuild being missing. scrypt is memory-hard,
// built in, has no build step, and at these parameters is comfortably strong
// enough for a self-hosted app with a handful of accounts.
const PARAMS = {
  N: 2 ** 15, // CPU/memory cost. ~100ms per hash on modest hardware.
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
};

// scrypt with N=32768 needs more than Node's default 32MB maxmem, so it must be
// stated explicitly or the call throws. The formula below is scrypt's own
// minimum (128 * N * r * p) with headroom.
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * PARAMS.p * 2;

// Stored as a single self-describing string, so the cost parameters travel with
// the hash. That means these constants can be raised later without invalidating
// existing passwords: old hashes still verify against the values they were
// created with.
export async function hashPassword(password) {
  const salt = randomBytes(PARAMS.saltLength);
  const derived = await scrypt(password, salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, expectedB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(expectedB64, 'base64');

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * p * 2,
    });
    // Constant-time compare, so a wrong password cannot be narrowed down by
    // measuring how long the rejection took.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Rejects the passwords that actually get people compromised, and nothing else.
// Composition rules (one capital, one symbol) push users towards Password1! and
// are not worth the friction on a personal instance.
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters.';
  }
  if (password.length > 200) {
    return 'Password must be 200 characters or fewer.';
  }
  const trivial = new Set([
    'password12',
    'password123',
    '1234567890',
    'qwertyuiop',
    'letmein123',
  ]);
  if (trivial.has(password.toLowerCase())) {
    return 'That password is too common. Pick something else.';
  }
  return null;
}
