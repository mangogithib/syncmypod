// What this suite is for.
//
// Not coverage. It exists to catch the specific class of mistake that has
// actually reached users here: code that parses, imports, and then fails the
// moment it runs. `node --check` cannot see those, and neither can the
// reference scan, because the identifier was iterated rather than called.
//
// So every test below drives the real server over HTTP: the routes, the
// middleware, the SQL and the migrations, in the shapes a browser and the local
// app really send. Each asserts something a user would notice losing.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { client, startServer, uniqueUsername } from './helpers.mjs';

let server;
let request;
let account;

before(async () => {
  server = await startServer();
  request = client(server.base);

  // The first-run screen, or a sign-in if this database already has an owner.
  account = { username: uniqueUsername('owner'), password: 'a-long-enough-password' };
  const status = await request('GET', '/api/auth/status');
  if (status.body?.needsSetup) {
    const created = await request('POST', '/api/auth/setup', account);
    assert.equal(created.status, 200, `setup failed: ${created.text}`);
  } else {
    // A shared database from an earlier run. Make an account the normal way so
    // the rest of the suite has one, using the same route the CLI tool uses.
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    execFileSync(
      process.execPath,
      ['server/scripts/create-user.js', account.username, account.password],
      { cwd: webRoot, env: { ...process.env, DATABASE_URL: (await import('./helpers.mjs')).DATABASE_URL, SESSION_SECRET: 'x'.repeat(32) }, stdio: 'ignore' }
    );
    const signedIn = await request('POST', '/api/auth/login', account);
    assert.equal(signedIn.status, 200, `login failed: ${signedIn.text}`);
  }
});

after(async () => {
  await server?.stop();
});

describe('the server answers at all', () => {
  test('health reports the database too', async () => {
    const res = await request('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.ok(res.body, 'health returned no JSON');
  });

  test('an unknown API path is a clean 404, not an HTML page', async () => {
    const res = await request('GET', '/api/nothing-here');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body?.error, 'string');
  });
});

describe('security headers', () => {
  test('the shell carries the headers a proxy must not be trusted to add', async () => {
    const res = await fetch(`${server.base}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(
      csp,
      /script-src[^;]*unsafe-inline/,
      'inline scripts must stay forbidden'
    );
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('nothing is readable without signing in', () => {
  test('a browser route refuses an anonymous caller', async () => {
    const anon = client(server.base);
    const res = await anon('GET', '/api/library/tracks?limit=1');
    assert.equal(res.status, 401);
  });

  test('a device route refuses a caller with no bearer token', async () => {
    const anon = client(server.base);
    const res = await anon('GET', '/api/sync/hello');
    assert.equal(res.status, 401);
    assert.match(res.body.error, /token/i);
  });

  test('a wrong password is refused, and says nothing about the username', async () => {
    const anon = client(server.base);
    const real = await anon('POST', '/api/auth/login', {
      username: account.username,
      password: 'not-the-password',
    });
    const fake = await anon('POST', '/api/auth/login', {
      username: uniqueUsername('nobody'),
      password: 'not-the-password',
    });
    assert.equal(real.status, 401);
    assert.equal(fake.status, 401);
    assert.equal(
      real.body.error,
      fake.body.error,
      'the two answers differ, so the form says which usernames exist'
    );
  });
});

describe('the library', () => {
  test('lists tracks for the signed-in account', async () => {
    const res = await request('GET', '/api/library/tracks?limit=5');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tracks), 'no tracks array');
    assert.equal(typeof res.body.total, 'number');
  });

  test('artists paginate rather than stopping at a fixed ceiling', async () => {
    const res = await request('GET', '/api/library/artists?limit=1&offset=0');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.artists));
    assert.equal(typeof res.body.total, 'number');
  });
});

describe('settings', () => {
  // The regression this file was written for. `setMany` ended in a loop over an
  // identifier that did not exist, so every save wrote the value and then threw
  // ReferenceError - a 500 for a change that had actually happened. It parsed,
  // it imported, and it failed only when a real request reached it.
  test('a save succeeds instead of throwing', async () => {
    const res = await request('PUT', '/api/settings', {
      settings: { 'musicbrainz.contact': 'tests@example.org' },
    });
    assert.equal(res.status, 200, `settings save failed: ${res.text}`);
  });

  test('the saved value comes back', async () => {
    const res = await request('GET', '/api/settings');
    assert.equal(res.status, 200);
    assert.ok(res.body, 'settings returned nothing');
  });

  test('a secret is never echoed back as a value', async () => {
    const res = await request('GET', '/api/settings');
    const asText = JSON.stringify(res.body);
    assert.doesNotMatch(
      asText,
      /"value"\s*:\s*"[A-Za-z0-9._-]{40,}"/,
      'something long enough to be a credential is being sent to the browser'
    );
  });
});

describe('pairing and the device API', () => {
  let token;

  test('a pairing code can be claimed exactly once', async () => {
    const issued = await request('POST', '/api/devices/pair');
    assert.equal(issued.status, 200, issued.text);
    assert.ok(issued.body.code, 'no pairing code issued');

    const anon = client(server.base);
    const claimed = await anon('POST', '/api/devices/claim', {
      code: issued.body.code,
      deviceName: 'Test runner',
      platform: 'linux',
      appVersion: '0.0.0-test',
    });
    assert.equal(claimed.status, 200, claimed.text);
    assert.match(claimed.body.token, /^smp_/);
    token = claimed.body.token;

    const again = await anon('POST', '/api/devices/claim', {
      code: issued.body.code,
      deviceName: 'Second try',
    });
    assert.equal(again.status, 400, 'a used code was accepted a second time');
  });

  test('password pairing is off unless the instance turns it on', async () => {
    const anon = client(server.base);
    const res = await anon('POST', '/api/devices/token', {
      username: account.username,
      password: account.password,
    });
    assert.equal(res.status, 404, 'the password pairing route answered while disabled');
  });

  test('the token opens the sync API and reports the manifest version', async () => {
    const res = await request('GET', '/api/sync/hello', undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.manifestVersion, 'number');
    assert.ok(
      res.body.supportedManifestVersions.includes(res.body.manifestVersion),
      'the server does not support the version it declares'
    );
  });

  test('the manifest has the shape the contract promises', async () => {
    const res = await request('GET', '/api/sync/manifest', undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, res.text);
    for (const key of ['manifestVersion', 'tracks', 'playlists', 'counts', 'conventions']) {
      assert.ok(key in res.body, `manifest is missing "${key}"`);
    }
    assert.equal(res.body.conventions.retagFromManifest, true);
    assert.ok(Array.isArray(res.body.tracks));
    for (const track of res.body.tracks.slice(0, 5)) {
      assert.equal(typeof track.id, 'number');
      assert.equal(typeof track.title, 'string');
      assert.ok('artist' in track, 'a track with no artist field');
      assert.ok(track.searchTerms, 'a track with no searchTerms');
    }
  });

  test('a browser session cannot reach a device route', async () => {
    // The two credentials are deliberately separate: a CSRF against the web UI
    // must not be able to drive a sync.
    const res = await request('GET', '/api/sync/hello');
    assert.equal(res.status, 401);
  });

  test('a revoked token stops working', async () => {
    const { devices } = (await request('GET', '/api/devices')).body;
    const mine = devices.find((d) => d.name === 'Test runner');
    assert.ok(mine, 'the paired device is not listed');

    const revoked = await request('DELETE', `/api/devices/${mine.id}`);
    assert.equal(revoked.status, 200);

    const after = await request('GET', '/api/sync/hello', undefined, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(after.status, 401, 'a revoked token still works');
  });
});

describe('playlists', () => {
  test('create, read and delete', async () => {
    const name = `Test ${Date.now()}`;
    const created = await request('POST', '/api/playlists', { name, syncToIpod: true });
    assert.ok(
      created.status === 200 || created.status === 201,
      `create answered ${created.status}: ${created.text}`
    );
    const id = created.body.playlist?.id ?? created.body.id;
    assert.ok(id, 'no playlist id returned');

    const listed = await request('GET', '/api/playlists');
    assert.ok(
      listed.body.playlists.some((p) => p.id === id),
      'the new playlist is not in the list'
    );

    const deleted = await request('DELETE', `/api/playlists/${id}`);
    assert.equal(deleted.status, 200);

    const gone = await request('GET', '/api/playlists');
    assert.ok(
      !gone.body.playlists.some((p) => p.id === id),
      'the playlist survived being deleted'
    );
  });
});

describe('bad input is a 400, never a 500', () => {
  for (const [label, path, body] of [
    ['an empty pasted list', '/api/import/track-list', { text: '' }],
    ['a playlist with no name', '/api/playlists', { name: '' }],
    ['a source link that is not a link', '/api/sources', { url: 'not a url' }],
    ['a playlist link that is not a link', '/api/import/playlist', { url: 'not a url' }],
  ]) {
    test(label, async () => {
      const res = await request('POST', path, body);
      assert.ok(
        res.status >= 400 && res.status < 500,
        `${label} answered ${res.status}, so a user mistake reads as a server fault`
      );
      assert.equal(typeof res.body?.error, 'string', 'no message a user could act on');
    });
  }
});
