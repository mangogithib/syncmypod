import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, waitForDatabase } from './pool.js';

// A deliberately minimal migration runner: numbered .sql files applied in
// filename order, each in its own transaction, each recorded so it never runs
// twice. No down-migrations - on a self-hosted app the honest recovery path is
// restore-from-backup, and a half-tested rollback script is worse than not
// having one.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations() {
  await waitForDatabase();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations'
    );
    const alreadyApplied = new Set(applied.map((row) => row.filename));

    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      // One transaction per migration: a failing migration leaves the schema
      // exactly as it was, so the fix is edit-and-rerun rather than
      // reconstruct-by-hand.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }

    console.log(
      count === 0
        ? '[migrate] schema up to date'
        : `[migrate] applied ${count} migration(s)`
    );
  } finally {
    client.release();
  }
}

// Also usable standalone: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate]', err.message);
      process.exit(1);
    });
}
