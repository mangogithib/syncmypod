import { Router } from 'express';
import { requireDevice } from '../auth/middleware.js';
import { many, one, query } from '../db/pool.js';
import { badRequest, handler, id, notFound, str } from '../lib/api.js';
import { buildManifest, recordSyncResults } from '../services/manifest.js';

export const syncRoutes = Router();

// The device API. Every route here is authenticated by a device bearer token and
// never by a browser session, so a CSRF against the web UI cannot reach it.
syncRoutes.use(requireDevice);

// Confirms the token works and tells the local app what the server expects.
// Called at startup, so a revoked token surfaces immediately as "please pair
// again" rather than as a confusing failure mid-sync.
syncRoutes.get(
  '/hello',
  handler(async (req, res) => {
    res.json({
      ok: true,
      manifestVersion: 1,
      device: { id: req.device.id, name: req.device.name },
      user: { id: req.user.id, username: req.user.username },
      // The local app should refuse to run against a server it does not
      // understand, so the supported range is explicit.
      supportedManifestVersions: [1],
    });
  })
);

// Reports what the local app found when it looked at the iPod.
//
// Recorded rather than trusted-and-forgotten: the generation decides which
// iTunesDB dialect applies, and having it server-side means the web UI can show
// "160GB Classic, 41GB free" without the local app being open.
syncRoutes.post(
  '/device',
  handler(async (req, res) => {
    const capacity = req.body?.ipodCapacityBytes;
    const free = req.body?.ipodFreeBytes;

    await query(
      `UPDATE devices
          SET ipod_name        = COALESCE($2, ipod_name),
              ipod_model       = COALESCE($3, ipod_model),
              ipod_generation  = COALESCE($4, ipod_generation),
              ipod_serial      = COALESCE($5, ipod_serial),
              ipod_capacity_bytes = COALESCE($6, ipod_capacity_bytes),
              ipod_free_bytes     = COALESCE($7, ipod_free_bytes),
              ipod_needs_hash     = COALESCE($8, ipod_needs_hash),
              platform         = COALESCE($9, platform),
              app_version      = COALESCE($10, app_version),
              last_seen_at     = now()
        WHERE id = $1`,
      [
        req.device.id,
        str(req.body?.ipodName, 'ipodName', { max: 200 }),
        str(req.body?.ipodModel, 'ipodModel', { max: 100 }),
        str(req.body?.ipodGeneration, 'ipodGeneration', { max: 60 }),
        str(req.body?.ipodSerial, 'ipodSerial', { max: 100 }),
        Number.isFinite(Number(capacity)) ? Number(capacity) : null,
        Number.isFinite(Number(free)) ? Number(free) : null,
        typeof req.body?.ipodNeedsHash === 'boolean' ? req.body.ipodNeedsHash : null,
        str(req.body?.platform, 'platform', { max: 60 }),
        str(req.body?.appVersion, 'appVersion', { max: 40 }),
      ]
    );
    res.json({ ok: true });
  })
);

// The manifest: everything that should be on this iPod.
syncRoutes.get(
  '/manifest',
  handler(async (req, res) => {
    const manifest = await buildManifest(req.user.id, req.device.id);
    if (!manifest) throw notFound('Device not found.');
    res.json(manifest);
  })
);

// Opens a sync run, so a sync in progress is visible in the web UI and a crashed
// one is distinguishable from a completed one.
syncRoutes.post(
  '/runs',
  handler(async (req, res) => {
    // Any run still marked running for this device is stale by definition - the
    // local app only syncs one iPod at a time. Closing it here means a crash
    // last time does not leave the UI claiming a sync is still going.
    await query(
      `UPDATE sync_runs
          SET status = 'error',
              finished_at = now(),
              message = 'Abandoned - a new sync started before this one finished.'
        WHERE device_id = $1 AND status = 'running'`,
      [req.device.id]
    );

    const run = await one(
      `INSERT INTO sync_runs (device_id, stats)
       VALUES ($1, $2)
       RETURNING id, started_at AS "startedAt"`,
      [
        req.device.id,
        JSON.stringify({
          planned: Number(req.body?.planned) || 0,
          toDownload: Number(req.body?.toDownload) || 0,
          toRemove: Number(req.body?.toRemove) || 0,
        }),
      ]
    );
    res.status(201).json(run);
  })
);

// Progress reports during a run, batched by the local app.
//
// Accepting results incrementally rather than only at the end means a sync
// interrupted halfway still records the tracks that did land, so the next run
// does not download them again.
syncRoutes.post(
  '/runs/:id/results',
  handler(async (req, res) => {
    const runId = id(req.params.id, 'Run id');
    const run = await one(
      'SELECT id, status FROM sync_runs WHERE id = $1 AND device_id = $2',
      [runId, req.device.id]
    );
    if (!run) throw notFound('Sync run not found.');

    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    if (results.length === 0) throw badRequest('No results supplied.');
    if (results.length > 500) throw badRequest('Send at most 500 results per request.');

    const summary = await recordSyncResults(req.device.id, results);

    // Only tracks the local app confirmed it removed. The server never assumes a
    // removal happened: if the user declined the removal prompt, these rows must
    // stay put.
    const removedIds = results
      .filter((result) => result.state === 'removed')
      .map((result) => Number(result.trackId))
      .filter(Number.isInteger);
    if (removedIds.length > 0) {
      await query(
        'DELETE FROM device_tracks WHERE device_id = $1 AND track_id = ANY($2::bigint[])',
        [req.device.id, removedIds]
      );
    }

    res.json(summary);
  })
);

syncRoutes.post(
  '/runs/:id/finish',
  handler(async (req, res) => {
    const runId = id(req.params.id, 'Run id');
    const status = ['done', 'error', 'cancelled'].includes(req.body?.status)
      ? req.body.status
      : 'done';

    const run = await one(
      `UPDATE sync_runs
          SET status = $3,
              finished_at = now(),
              stats = stats || $4::jsonb,
              message = $5
        WHERE id = $1 AND device_id = $2
        RETURNING id, status, started_at AS "startedAt", finished_at AS "finishedAt", stats`,
      [
        runId,
        req.device.id,
        status,
        JSON.stringify(req.body?.stats || {}),
        str(req.body?.message, 'Message', { max: 2000 }),
      ]
    );
    if (!run) throw notFound('Sync run not found.');
    res.json(run);
  })
);

// What the server believes is on this device. The local app can use it to
// shortcut a full filesystem scan, and the UI uses it for "41 of 50 synced".
// What the local app found when it looked for each track's audio.
//
// The point is that it can be run without an iPod attached and without
// downloading anything, so "which of my songs cannot be found" stops being
// something you only discover part way through a sync.
//
// A found URL is written to source_hint, which is the same field a user can
// paste into by hand - so the next sync skips the search for that track
// entirely and gets faster as a side effect. A hand-pasted link is never
// overwritten: the user chose it deliberately and the search did not.
syncRoutes.post(
  '/matches',
  handler(async (req, res) => {
    const matches = Array.isArray(req.body?.matches) ? req.body.matches : [];
    if (matches.length === 0) throw badRequest('No matches supplied.');
    if (matches.length > 500) throw badRequest('Send at most 500 matches per request.');

    const found = [];
    const missing = [];
    for (const match of matches) {
      const trackId = Number(match?.trackId);
      if (!Number.isInteger(trackId)) continue;
      const url = str(match?.sourceUrl, 'sourceUrl', { max: 1000 });
      if (url) found.push({ trackId, url });
      else missing.push(trackId);
    }

    const userId = req.user.id;

    if (found.length > 0) {
      // One statement rather than a loop: unnest turns the two arrays into rows
      // to join against, which is a single round trip for a batch of 500.
      await query(
        `UPDATE library_tracks lt
            SET source_hint       = COALESCE(NULLIF(lt.source_hint, ''), incoming.url),
                source_checked_at = now(),
                source_missing    = false
           FROM (SELECT * FROM unnest($2::bigint[], $3::text[]) AS t(track_id, url)) AS incoming
          WHERE lt.user_id = $1 AND lt.track_id = incoming.track_id`,
        [userId, found.map((entry) => entry.trackId), found.map((entry) => entry.url)]
      );
    }

    if (missing.length > 0) {
      await query(
        `UPDATE library_tracks
            SET source_checked_at = now(),
                source_missing    = true
          WHERE user_id = $1 AND track_id = ANY($2::bigint[])`,
        [userId, missing]
      );
    }

    res.json({ found: found.length, missing: missing.length });
  })
);

syncRoutes.get(
  '/state',
  handler(async (req, res) => {
    const tracks = await many(
      `SELECT track_id AS "trackId", state, synced_at AS "syncedAt",
              format, bitrate, file_size AS "fileSize", attempts, error
         FROM device_tracks
        WHERE device_id = $1`,
      [req.device.id]
    );
    res.json({ tracks, count: tracks.length });
  })
);
