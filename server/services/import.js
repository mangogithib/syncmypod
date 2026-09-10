import { one, query, transaction } from '../db/pool.js';
import * as spotify from '../providers/spotify.js';
import { appendToPlaylist } from './playlist-writes.js';
import { resolveAndSave } from './resolver.js';

// Importing playlists from an external service.
//
// Runs in the background rather than inside the HTTP request. A 300-track
// playlist means 300 resolutions, and while most are cheap (a Spotify import
// already carries provider ids, so tier-1 resolution hits immediately), any that
// fall through to MusicBrainz cost a second each. A request that takes four
// minutes gets killed by a proxy long before it finishes.
//
// So: the route creates a job row and returns immediately, this module works
// through it, and the UI polls the job for progress. State lives in Postgres,
// which means progress survives a container restart mid-import.

// Jobs currently running in this process, so a duplicate request does not start
// a second worker for the same job.
const running = new Set();

export async function startSpotifyPlaylistImport(userId, spotifyPlaylistId, options = {}) {
  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, status, target_playlist_id)
     VALUES ($1, 'spotify-playlist', $2, 'queued', $3)
     RETURNING id`,
    [userId, spotifyPlaylistId, options.targetPlaylistId || null]
  );

  // Deliberately not awaited: the caller returns the job id straight away.
  // The catch is essential - an unhandled rejection here would take the process
  // down and lose every other job with it.
  runJob(job.id, () => importSpotifyPlaylist(job.id, userId, spotifyPlaylistId, options))
    .catch((err) => console.error(`[import] job ${job.id} crashed:`, err.message));

  return job.id;
}

export async function startSpotifySavedImport(userId, options = {}) {
  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_name, status, target_playlist_id)
     VALUES ($1, 'spotify-saved', 'Liked Songs', 'queued', $2)
     RETURNING id`,
    [userId, options.targetPlaylistId || null]
  );

  runJob(job.id, () => importSpotifySaved(job.id, userId, options))
    .catch((err) => console.error(`[import] job ${job.id} crashed:`, err.message));

  return job.id;
}

async function runJob(jobId, fn) {
  if (running.has(jobId)) return;
  running.add(jobId);
  try {
    await fn();
  } catch (err) {
    console.error(`[import] job ${jobId} failed:`, err.message);
    await query(
      `UPDATE import_jobs
          SET status = 'error', error = $2, finished_at = now()
        WHERE id = $1`,
      [jobId, err.message.slice(0, 2000)]
    ).catch(() => {});
  } finally {
    running.delete(jobId);
  }
}

async function importSpotifyPlaylist(jobId, userId, spotifyPlaylistId, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  const { playlist, tracks } = await spotify.getPlaylistTracks(userId, spotifyPlaylistId);

  await query(
    `UPDATE import_jobs SET total = $2, source_name = $3 WHERE id = $1`,
    [jobId, tracks.length, playlist.name]
  );

  // Create or reuse the destination playlist unless the caller only wants the
  // tracks in the library.
  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist !== false) {
    targetPlaylistId = await ensurePlaylist(userId, playlist.name, {
      description: playlist.description,
      source: 'spotify',
      sourceRef: playlist.spotifyId,
    });
    await query('UPDATE import_jobs SET target_playlist_id = $2 WHERE id = $1', [
      jobId,
      targetPlaylistId,
    ]);
  }

  await processTracks(jobId, userId, tracks, {
    targetPlaylistId,
    addedVia: 'spotify-import',
  });
}

async function importSpotifySaved(jobId, userId, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  const tracks = await spotify.getMySavedTracks(userId);
  await query('UPDATE import_jobs SET total = $2 WHERE id = $1', [jobId, tracks.length]);

  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist) {
    targetPlaylistId = await ensurePlaylist(userId, 'Liked Songs', {
      source: 'spotify',
      sourceRef: 'saved-tracks',
    });
  }

  await processTracks(jobId, userId, tracks, {
    targetPlaylistId,
    addedVia: 'spotify-import',
  });
}

// The shared body of every import: resolve each track, add it to the library,
// optionally add it to a playlist, and keep the job row current.
async function processTracks(jobId, userId, tracks, { targetPlaylistId, addedVia }) {
  let processed = 0;
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const report = [];

  for (const track of tracks) {
    try {
      // A Spotify import already knows the provider id and usually the ISRC, so
      // resolution is a direct lookup rather than a search. Passing them through
      // is what makes a large import fast.
      const { trackId, resolution } = await resolveAndSave({
        spotifyId: track.spotifyId,
        isrc: track.isrc,
        title: track.title,
        artist: (track.artists || []).map((artist) => artist.name).join(', '),
        album: track.album?.name,
        durationMs: track.durationMs,
      });

      const result = await query(
        `INSERT INTO library_tracks (user_id, track_id, added_via)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, track_id) DO NOTHING`,
        [userId, trackId, addedVia]
      );

      if (result.rowCount > 0) added++;
      else skipped++;

      if (targetPlaylistId) await appendToPlaylist(targetPlaylistId, trackId);

      if (resolution.state !== 'resolved') {
        report.push({
          title: track.title,
          state: resolution.state,
          reason: resolution.reason || 'Could not resolve metadata.',
        });
      }
    } catch (err) {
      failed++;
      report.push({ title: track.title, state: 'error', reason: err.message });
    }

    processed++;

    // Progress is written every ten tracks rather than every track: the UI polls
    // at a slower rate than that, so per-track updates would be pure write load.
    if (processed % 10 === 0 || processed === tracks.length) {
      await query(
        `UPDATE import_jobs
            SET processed = $2, added = $3, skipped = $4, failed = $5
          WHERE id = $1`,
        [jobId, processed, added, skipped, failed]
      );
    }
  }

  await query(
    `UPDATE import_jobs
        SET status = 'done', processed = $2, added = $3, skipped = $4, failed = $5,
            report = $6::jsonb, finished_at = now()
      WHERE id = $1`,
    // The report is capped: a wholly failed 5000-track import should not write a
    // multi-megabyte JSONB row.
    [jobId, processed, added, skipped, failed, JSON.stringify(report.slice(0, 200))]
  );
}

// Finds or creates a playlist by name. Re-importing the same Spotify playlist
// should update the existing one rather than making "My Mix (2)".
async function ensurePlaylist(userId, name, { description, source, sourceRef } = {}) {
  return transaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM playlists
        WHERE user_id = $1 AND (source_ref = $2 OR lower(name) = lower($3))
     ORDER BY (source_ref = $2) DESC
        LIMIT 1`,
      [userId, sourceRef || null, name]
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const created = await client.query(
      `INSERT INTO playlists (user_id, name, description, source, source_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, name, description || null, source || 'local', sourceRef || null]
    );
    return created.rows[0].id;
  });
}

export async function getJob(userId, jobId) {
  return one(
    `SELECT id, source, source_ref AS "sourceRef", source_name AS "sourceName",
            status, total, processed, added, skipped, failed,
            target_playlist_id AS "targetPlaylistId",
            error, report, created_at AS "createdAt", finished_at AS "finishedAt"
       FROM import_jobs
      WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
}

// Marks jobs orphaned by a restart as failed.
//
// A job row says 'running' but the in-process worker that owned it is gone, and
// nothing will ever finish it. Called once at startup so the UI does not show a
// permanently spinning import.
export async function failOrphanedJobs() {
  const { rowCount } = await query(
    `UPDATE import_jobs
        SET status = 'error',
            error = 'Interrupted by a server restart. Start the import again.',
            finished_at = now()
      WHERE status IN ('queued', 'running')`
  );
  if (rowCount > 0) console.log(`[import] marked ${rowCount} orphaned job(s) as failed`);
  return rowCount;
}
