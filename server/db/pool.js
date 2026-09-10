import pg from 'pg';
import { config } from '../config.js';

// Postgres returns BIGINT as a string by default, because a 64-bit integer does
// not always fit a JS number. Every bigint in this schema is a surrogate key or
// a byte count, so none will ever exceed Number.MAX_SAFE_INTEGER in practice,
// and having ids arrive as numbers rather than strings avoids a whole class of
// `id === "3"` vs `id === 3` bugs in the API layer.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) =>
  value === null ? null : Number(value)
);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// A pool client can emit an error while idle (database restarted, network
// blipped). Unhandled, that takes the whole process down; the pool will happily
// establish a fresh connection on the next query, so log it and carry on.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

// First row or null. Most lookups in this app are "the one row or nothing".
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Runs fn inside a transaction, committing on success and rolling back on any
// throw. Used wherever a single user action touches several tables and a partial
// result would be wrong: importing a track writes artists, albums, tracks and
// track_artists, and a half-written track is worse than no track.
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The original error is the useful one; a failed rollback usually means
      // the connection is already gone.
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

// Waits for Postgres to accept connections. Compose already gates the app on the
// database healthcheck, but a `docker compose restart db` under a running app
// does not, and retrying beats crash-looping.
export async function waitForDatabase({ attempts = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(
        `[db] not ready (${err.code || err.message}), retry ${attempt}/${attempts}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
