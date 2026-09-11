import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachSession } from './auth/middleware.js';
import { pruneRateLimitBuckets } from './auth/middleware.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { prunePairingCodes } from './auth/tokens.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { pool, query } from './db/pool.js';
import { HttpError } from './lib/api.js';
import { pruneProviderCache } from './lib/http.js';
import * as deezer from './providers/deezer.js';
import * as itunes from './providers/itunes.js';
import * as musicbrainz from './providers/musicbrainz.js';
import { artistRoutes } from './routes/artists.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { importRoutes } from './routes/import.js';
import { libraryRoutes } from './routes/library.js';
import { playlistRoutes } from './routes/playlists.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { syncRoutes } from './routes/sync.js';
import { youtubeAccountRoutes } from './routes/youtube-account.js';
import { loadSettings } from './services/app-settings.js';
import { checkDueFollows } from './services/follows.js';
import { failOrphanedJobs } from './services/import.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();

// Behind a reverse proxy, req.ip and req.secure must come from X-Forwarded-*,
// and without one they must not - otherwise any client can spoof its own IP and
// walk straight past the rate limiter. See parseTrustProxy in config.js for why
// a CIDR list is preferred over a hop count.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// 1MB is generous for the largest legitimate body (a 200-item batch add) and
// small enough that a runaway client cannot exhaust memory.
app.use(express.json({ limit: '1mb' }));

// Security headers, applied to everything including the static frontend.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The frontend is plain ES modules with no inline scripts, so script-src can
  // stay strict. img-src has to allow https: because album artwork is served
  // from the providers' and the Cover Art Archive's CDNs - the alternative would be
  // proxying every thumbnail through this server for no benefit.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; ')
  );
  next();
});

// Ping Postgres too: an app that answers 200 while its database is unreachable
// is not healthy, and the container healthcheck should say so.
app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      ok: true,
      providers: {
        deezer: deezer.isEnabled(),
        itunes: itunes.isEnabled(),
        musicbrainz: musicbrainz.isEnabled(),
      },
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use(attachSession);

app.use('/api/auth', authRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/artists', artistRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/import', importRoutes);
app.use('/api/youtube-account', youtubeAccountRoutes);
app.use('/api/settings', settingsRoutes);
// The device API. Token-authenticated only - see requireDevice.
app.use('/api/sync', syncRoutes);

// An unmatched /api path is a 404 in JSON. Without this it would fall through to
// the SPA fallback below and a mistyped endpoint would return the HTML shell,
// which is a genuinely confusing thing to debug.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'No such endpoint.' });
});

app.use(
  express.static(publicDir, {
    // no-cache means "revalidate before reusing", not "do not cache". Combined
    // with the ETag express.static already sends, a repeat visit costs one
    // conditional request per asset and gets a 304.
    //
    // This matters because there is no bundler, so no content-hashed filenames
    // to bust a cache with. Without it, `docker compose up -d --build` leaves
    // browsers running the previous frontend against the new backend until
    // someone thinks to hard-refresh. The whole frontend is a few tens of KB,
    // so revalidating it is far cheaper than that class of bug.
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Client-side routing: any non-API path serves the app shell.
app.get('*', (_req, res) => {
  res.sendFile(join(publicDir, 'index.html'));
});

// Error handler. A deliberate HttpError becomes its own status and message; a
// bug becomes a 500 with the detail in the log and nothing leaked to the client.
app.use((err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // A provider being unreachable is a real, reportable condition rather than a
  // bug in this app, so it keeps its own status and message.
  if (err.name === 'ProviderError') {
    return res.status(err.status && err.status < 500 ? err.status : 502).json({
      error: err.message,
      provider: err.provider,
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong. Check the server logs.' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Housekeeping on a timer. All of it is idempotent and safe to skip, so a failure
// is logged rather than escalated.
function startHousekeeping() {
  const hourly = async () => {
    try {
      await pruneExpiredSessions();
      await prunePairingCodes();
      await pruneProviderCache();
      pruneRateLimitBuckets();
    } catch (err) {
      console.error('[housekeeping]', err.message);
    }
  };

  const follows = async () => {
    try {
      const result = await checkDueFollows();
      if (result.checked > 0) {
        console.log(
          `[follows] checked ${result.checked} artist(s), added ${result.added} track(s)`
        );
      }
    } catch (err) {
      console.error('[follows]', err.message);
    }
  };

  // unref() so these timers never hold the process open during shutdown.
  setInterval(hourly, 60 * 60 * 1000).unref();
  // Followed artists are checked every six hours. New releases appear on a
  // weekly cadence, so anything more frequent is just API traffic.
  setInterval(follows, 6 * 60 * 60 * 1000).unref();

  // A first pass shortly after boot rather than immediately, so startup is not
  // competing with an outbound API sweep.
  setTimeout(follows, 60 * 1000).unref();
}

async function start() {
  await runMigrations();
  // Provider credentials live in the database as well as the environment, and
  // every isEnabled() check reads them synchronously from this cache, so it has
  // to be populated before the server starts accepting requests.
  await loadSettings();
  // Any job left 'running' belongs to a process that no longer exists.
  await failOrphanedJobs();

  const server = app.listen(config.port, () => {
    console.log(`[syncmypod] listening on :${config.port} (${config.env})`);
    const providers = {
      deezer: deezer.isEnabled(),
      itunes: itunes.isEnabled(),
      musicbrainz: musicbrainz.isEnabled(),
    };
    console.log(
      `[syncmypod] providers - ${Object.entries(providers)
        .map(([name, on]) => `${name}: ${on ? 'on' : 'off'}`)
        .join(', ')}`
    );
    if (!Object.values(providers).some(Boolean)) {
      console.warn(
        '[syncmypod] No metadata provider is available. Search and resolution will fail until one is.'
      );
    }
  });

  startHousekeeping();

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the pool. Without this, `docker compose restart` can
  // interrupt an import mid-write.
  const shutdown = (signal) => {
    console.log(`[syncmypod] ${signal} received, shutting down`);
    server.close(async () => {
      try {
        await pool.end();
      } catch (err) {
        console.error('[syncmypod] pool close failed:', err.message);
      }
      process.exit(0);
    });
    // A client holding a keep-alive connection open should not be able to
    // prevent shutdown indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[syncmypod] failed to start:', err);
  process.exit(1);
});
