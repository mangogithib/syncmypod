import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/passwords.js';
import { one, pool, waitForDatabase } from '../db/pool.js';

// Creates an account from the command line:
//
//   docker compose exec app npm run create-user -- <username> [password]
//
// The web UI's first-run screen is the normal way in. This exists for the cases
// it cannot cover: a forgotten password, or a headless setup where nobody has a
// browser pointed at the instance yet.
//
// The password is taken as an argument rather than prompted for, because this
// runs under `docker compose exec` where stdin is not reliably a TTY. Omit it and
// a strong one is generated and printed.

async function main() {
  const [username, providedPassword] = process.argv.slice(2);

  if (!username) {
    console.error(
      'Usage: npm run create-user -- <username> [password]\n' +
        '       Omit the password to have one generated.'
    );
    process.exit(1);
  }

  await waitForDatabase();

  const existing = await one(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username]
  );

  // 18 random bytes as base64url: ~24 characters, no ambiguity about what to
  // type, comfortably past the length check in validatePassword.
  const password = providedPassword || randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);

  if (existing) {
    // Resetting rather than refusing is the useful behaviour: "I locked myself
    // out" is the main reason anyone runs this.
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      existing.id,
      passwordHash,
    ]);
    // Every browser session is dropped, since a password reset that leaves old
    // sessions alive has not really reset anything.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [existing.id]);
    console.log(`Password reset for existing user "${username}".`);
  } else {
    const isFirst = await one('SELECT count(*)::int AS count FROM users');
    await pool.query(
      `INSERT INTO users (username, password_hash, is_owner)
       VALUES ($1, $2, $3)`,
      [username, passwordHash, isFirst.count === 0]
    );
    console.log(`Created user "${username}".`);
  }

  if (!providedPassword) {
    console.log(`Password: ${password}`);
    console.log('Save it now - it is not stored anywhere in recoverable form.');
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
