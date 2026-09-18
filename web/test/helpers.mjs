// Scaffolding for the server tests.
//
// The server is started as a real child process against a real Postgres, and
// the tests talk to it over HTTP. That is deliberate rather than lazy: the two
// bugs this suite exists to have caught were both invisible to anything
// shallower. A settings save threw `ReferenceError` at runtime in a file that
// parsed perfectly, and a route used an import its module did not have. Only
// actually running the thing finds those.
//
// No test framework and no HTTP client beyond what Node ships. This project has
// two runtime dependencies on purpose, and a test suite that adds five of its
// own would be the tail wagging the dog.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://syncmypod:ci@127.0.0.1:5432/syncmypod';

// A port the operating system picks, so several runs can overlap and a
// developer's own instance on 3010 is never disturbed.
async function freePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Starts the server, waits for it to answer, and returns a handle.
 *
 * Migrations run on boot, as they do in production, so the schema under test is
 * the one a real deployment gets rather than a fixture that has drifted from it.
 */
export async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      BIND_ADDR: '127.0.0.1',
      // Kept off, so the suite proves the default rather than a configuration
      // only the tests use. One case turns it on explicitly.
      ALLOW_PASSWORD_PAIRING: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (${child.exitCode}):\n${output.join('')}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Server did not start in time:\n${output.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    base,
    output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * A fetch that carries cookies, so a signed-in session survives between calls.
 *
 * Node's fetch deliberately does not keep a cookie jar. The session cookie is
 * the thing most of these tests are about, so one is kept here by hand.
 */
export function client(base) {
  const cookies = new Map();

  return async function request(method, url, body, extra = {}) {
    const headers = { ...(extra.headers || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookies.size > 0) {
      headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });

    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not every response is JSON; the status is still worth asserting on.
    }
    return { status: res.status, headers: res.headers, body: json, text };
  };
}

/** A username nothing else in the suite will collide with. */
export function uniqueUsername(prefix = 'test') {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
