import { one, query, transaction } from '../db/pool.js';
import * as deezer from '../providers/deezer.js';
import * as playlistReaders from '../providers/playlists.js';
import * as sources from './sources.js';
import { appendToPlaylist } from './playlist-writes.js';
import { resolveAndSave } from './resolver.js';

// Bulk-importing tracks into the library.
//
// Three sources:
//
//   deezer-playlist   a public Deezer playlist, by URL or id
//   youtube-playlist  a public YouTube playlist, by URL or id
//   track-list        pasted text, one track per line
//   source:*          a standing source - a playlist link the library follows,
//                     re-read when the app is opened
//
// None needs an account or a key, which is a property worth keeping. A
// connected YouTube account was built and then removed: it needed a Google
// OAuth client registered per instance, and then the user's own account added
// by hand to that client's Test users list before it would work at all.
// Following a public playlist link does the same job with none of that.
//
// The pasted list is the more important of the two, and exists because there is
// no longer an API route into a Spotify library. It is also the only source that
// works for a library held anywhere else - a text file, a spreadsheet, an export
// from a service this app has never heard of. Every line goes through the same
// resolver as everything else, so a rough "Artist - Title" still lands with
// correct credits, artwork and an ISRC.
//
// Both run in the background rather than inside the HTTP request. A 300-track
// list means 300 resolutions, and while most are fast, any that fall through to
// MusicBrainz cost a second each. A request that takes four minutes gets killed
// by a proxy long before it finishes.
//
// So: the route creates a job row and returns immediately, this module works
// through it, and the UI polls the job. State lives in Postgres, so progress
// survives a container restart mid-import.

// Jobs currently running in this process, so a duplicate request does not start
// a second worker for the same job.
const running = new Set();

// One import for a playlist link from any service.
//
// Replaces the per-service starters this had before. Which platform a link
// belongs to comes from the address, because the address already says - asking
// the user to classify their own link first was a question with an obvious
// answer, and it meant a separate box per service on the Import page.
//
// Reading each service lives in providers/playlists.js; adding another is a
// reader there and nothing here.
export async function startPlaylistImport(userId, url, options = {}) {
  const detected = playlistReaders.detect(url);
  if (!detected) throw new Error(unrecognisedLink());

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, status, target_playlist_id)
     VALUES ($1, $2, $3, 'queued', $4)
     RETURNING id`,
    [userId, `${detected.platform}-playlist`, detected.ref, options.targetPlaylistId || null]
  );

  // Deliberately not awaited: the caller returns the job id straight away, and
  // the catch is essential or an unhandled rejection takes the process down.
  runJob(job.id, () => importPlaylist(job.id, userId, detected, options)).catch((err) =>
    console.error(`[import] job ${job.id} crashed:`, err.message)
  );

  return { jobId: job.id, platform: detected.platform };
}

export function unrecognisedLink() {
  const labels = Object.values(playlistReaders.PLATFORMS).map((spec) => spec.label);
  return (
    `That is not a playlist link this recognises. ${labels.slice(0, -1).join(', ')} and ` +
    `${labels.at(-1)} all work - paste the address straight from the browser or the ` +
    `app's share menu.`
  );
}

export async function importSourceTracks(userId, source) {
  const { sourceId, sourceName, sourceRef, kind, tracks } = source;
  if (tracks.length === 0) return null;

  let targetPlaylistId = source.targetPlaylistId || null;
  if (!targetPlaylistId) {
    targetPlaylistId = await ensurePlaylist(userId, sourceName, {
      source: kind.startsWith('youtube') ? 'youtube' : 'deezer',
      sourceRef,
    });
    await sources.rememberTarget(userId, sourceId, targetPlaylistId);
  }

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, source_name, status, total,
                              target_playlist_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6)
     RETURNING id`,
    [userId, `source:${kind}`, sourceRef, sourceName, tracks.length, targetPlaylistId]
  );

  const counts = await processItems(
    job.id,
    userId,
    tracks.map((track) => ({
      title: track.title,
      artist: track.artist || null,
      album: track.album || null,
      durationMs: track.durationMs || null,
      deezerId: track.deezerId || null,
      matchKeyExtra: track.trusted ? null : track.identity,
      // Only when it is genuinely a URL. A Deezer entry's identity is
      // "deezer:12345", which is an identity and not somewhere to download from.
      sourceHint: /^https?:\/\//.test(track.identity || '') ? track.identity : null,
    })),
    {
      targetPlaylistId,
      addedVia: `source:${kind}`,
      // Only where the source's own metadata is a guess. A Deezer record is not.
      discardUnverifiedMetadata: !tracks.every((track) => track.trusted),
    }
  );

  await sources.recordAdded(userId, sourceId, counts.added);

  // A check that found nothing new leaves no trace in the import history.
  // Otherwise following three playlists would fill that page with a row every
  // half hour saying nothing happened.
  if (counts.added === 0 && counts.failed === 0) {
    await query('DELETE FROM import_jobs WHERE id = $1', [job.id]);
    return null;
  }

  return job.id;
}

export async function startTrackListImport(userId, lines, options = {}) {
  const parsed = parseTrackList(lines, options.order);
  if (parsed.length === 0) {
    throw new Error('No usable lines found. Expected one track per line.');
  }

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_name, status, total, target_playlist_id)
     VALUES ($1, 'track-list', $2, 'queued', $3, $4)
     RETURNING id`,
    [
      userId,
      options.name || `Pasted list (${parsed.length} tracks)`,
      parsed.length,
      options.targetPlaylistId || null,
    ]
  );

  runJob(job.id, () => importTrackList(job.id, userId, parsed, options)).catch((err) =>
    console.error(`[import] job ${job.id} crashed:`, err.message)
  );

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

// ---------------------------------------------------------------------------
// Parsing a pasted list
// ---------------------------------------------------------------------------

// Turns pasted text into { title, artist } pairs.
//
// Handles the shapes people actually paste:
//
//   Artist - Title
//   Title<TAB>Artist          (spreadsheet columns)
//   "Title","Artist",...      (a CSV export, extra columns ignored)
//   3. Artist - Title         (a numbered list)
//
// `order` says which side is which for the dash and tab forms, because
// "Coldplay - Yellow" and "Yellow - Coldplay" are indistinguishable to a
// machine. It is a choice in the UI rather than a guess here: guessing wrong on
// 300 lines is far more annoying than picking from two options once.
export function parseTrackList(text, order = 'artist-title') {
  const out = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    // Strip a leading list number ("1.", "12)") and surrounding whitespace.
    const line = rawLine.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
    if (!line) continue;

    let left = null;
    let right = null;

    if (line.includes('\t')) {
      [left, right] = line.split('\t');
    } else if (/^\s*"/.test(line) && line.includes('","')) {
      // Quoted CSV. Only the first two fields matter; anything after is an
      // album, a date, a duration - none of which the resolver needs.
      const fields = line.match(/"((?:[^"]|"")*)"/g) || [];
      const values = fields.map((field) => field.slice(1, -1).replace(/""/g, '"'));
      // A CSV export puts the track name first, whatever the dash setting says
      // - that convention is near-universal and the `order` choice is about the
      // dash and tab forms.
      const pair = cleanPair(values[0], values[1]);
      if (!isHeaderRow(pair)) out.push(pair);
      continue;
    } else {
      // Split on the FIRST dash surrounded by spaces. Requiring the spaces is
      // what stops "Jay-Z" and "Blink-182" being torn in half.
      const match = /^(.*?)\s+[-–—]\s+(.*)$/.exec(line);
      if (match) {
        [, left, right] = match;
      } else {
        // No separator at all: treat the whole line as a title and let the
        // resolver's loose pass do what it can.
        const single = cleanPair(line, null);
        if (!isHeaderRow(single)) out.push(single);
        continue;
      }
    }

    const pair =
      order === 'title-artist' ? cleanPair(left, right) : cleanPair(right, left);
    if (!isHeaderRow(pair)) out.push(pair);
  }

  return out.filter((entry) => entry.title);
}

function cleanPair(title, artist) {
  return {
    title: String(title || '').trim() || null,
    artist: String(artist || '').trim() || null,
  };
}

// A spreadsheet header row rather than a song.
//
// Checked after parsing rather than against the raw line, because the column
// order varies - "Track,Artist" and "Artist,Track" are both common - and
// matching the parsed fields is order-independent. A row where every populated
// field is a bare column label is a header; no real song is called "Artist".
const HEADER_WORDS = new Set([
  'track',
  'track name',
  'title',
  'song',
  'song name',
  'name',
  'artist',
  'artists',
  'artist name',
  'album',
  'album name',
]);

function isHeaderRow({ title, artist }) {
  const fields = [title, artist].filter(Boolean).map((value) => value.toLowerCase().trim());
  if (fields.length === 0) return false;
  // A single field is only a header if the whole line was one label - which is
  // also why "Artist,Track" is caught: it has no recognised separator, so it
  // arrives here as one field, and the comma-joined form is normalised below.
  return fields.every(
    (value) =>
      HEADER_WORDS.has(value) ||
      value.split(/\s*,\s*/).every((part) => HEADER_WORDS.has(part))
  );
}

// ---------------------------------------------------------------------------
// The importers
// ---------------------------------------------------------------------------

async function importPlaylist(jobId, userId, detected, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  const playlist = await playlistReaders.read(detected.platform, detected.ref);

  await query(`UPDATE import_jobs SET total = $2, source_name = $3 WHERE id = $1`, [
    jobId,
    playlist.tracks.length,
    playlist.name,
  ]);

  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist !== false) {
    targetPlaylistId = await ensurePlaylist(userId, playlist.name, {
      source: detected.platform,
      sourceRef: detected.ref,
    });
    await query('UPDATE import_jobs SET target_playlist_id = $2 WHERE id = $1', [
      jobId,
      targetPlaylistId,
    ]);
  }

  await processItems(
    jobId,
    userId,
    playlist.tracks.map((track) => ({
      title: track.title,
      artist: track.artist || null,
      album: track.album || null,
      durationMs: track.durationMs || null,
      // A Deezer entry carries a real track id, so the resolver hydrates it
      // directly instead of searching. Nothing else here has one.
      deezerId: track.deezerId || null,
      matchKeyExtra: track.identity || null,
      sourceHint: track.sourceHint || null,
    })),
    {
      targetPlaylistId,
      addedVia: `${detected.platform}-import`,
      // A YouTube playlist is a list of videos, so its "artist" was split out of
      // a title and is discarded unless a catalogue confirms it. Spotify, Apple
      // Music and Deezer are music catalogues - their credits are records, so an
      // unmatched track keeps what they said rather than arriving blank.
      discardUnverifiedMetadata: playlist.quality === 'upload',
    }
  );
}

async function importTrackList(jobId, userId, parsed, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist && options.name) {
    targetPlaylistId = await ensurePlaylist(userId, options.name, { source: 'local' });
    await query('UPDATE import_jobs SET target_playlist_id = $2 WHERE id = $1', [
      jobId,
      targetPlaylistId,
    ]);
  }

  await processItems(jobId, userId, parsed, {
    targetPlaylistId,
    addedVia: 'list-import',
  });
}

// The shared body of every import: resolve each item, add it to the library,
// optionally add it to a playlist, and keep the job row current.
//
// `carried` and `jobTotal` are for a job made of several playlists. Counts are
// written as carried-plus-mine so the job row always shows the whole job, and
// the row is only marked done once the job's own total has been reached -
// otherwise the first playlist to finish would close the job while the rest
// were still running.
async function processItems(
  jobId,
  userId,
  items,
  {
    targetPlaylistId,
    addedVia,
    discardUnverifiedMetadata = false,
    carried = null,
    jobTotal = null,
  }
) {
  const before = carried || { processed: 0, added: 0, skipped: 0, failed: 0 };
  const total = jobTotal ?? items.length;
  let processed = 0;
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const report = [];

  for (const item of items) {
    try {
      const { trackId, resolution } = await resolveAndSave(item, {
        discardUnverifiedMetadata,
      });

      // The source URL travels with the track, and matters most for exactly
      // the tracks that do not resolve. The local app short-circuits its
      // YouTube search when a sourceHint is present, so a song with no artist
      // is still fetched from the right recording rather than from whatever a
      // title-only search turns up - which, for a song with no artist, is the
      // weakest search there is.
      const result = await query(
        `INSERT INTO library_tracks (user_id, track_id, added_via, source_hint)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, track_id) DO UPDATE
            SET source_hint = COALESCE(library_tracks.source_hint, EXCLUDED.source_hint)
         RETURNING (xmax = 0) AS inserted`,
        [userId, trackId, addedVia, item.sourceHint || null]
      );

      // DO UPDATE always reports a row, so "was this new" can no longer be read
      // from rowCount. The insert reports it instead.
      if (result.rows?.[0]?.inserted) added++;
      else skipped++;

      if (targetPlaylistId) await appendToPlaylist(targetPlaylistId, trackId);

      if (resolution.state !== 'resolved') {
        report.push({
          title: item.title,
          state: resolution.state,
          reason: discardUnverifiedMetadata
            ? 'No catalogue had this, so it was added with a title only. Fill in the artist to sync it.'
            : resolution.reason || 'Could not resolve metadata.',
        });
      }
    } catch (err) {
      failed++;
      report.push({ title: item.title, state: 'error', reason: err.message });
    }

    processed++;

    // Progress is written every ten items rather than every one: the UI polls
    // more slowly than that, so per-item updates would be pure write load.
    if (processed % 10 === 0 || processed === items.length) {
      await query(
        `UPDATE import_jobs
            SET processed = $2, added = $3, skipped = $4, failed = $5
          WHERE id = $1`,
        [
          jobId,
          before.processed + processed,
          before.added + added,
          before.skipped + skipped,
          before.failed + failed,
        ]
      );
    }
  }

  const finished = before.processed + processed >= total;
  await query(
    `UPDATE import_jobs
        SET status = CASE WHEN $7 THEN 'done' ELSE status END,
            processed = $2, added = $3, skipped = $4, failed = $5,
            report = COALESCE(report, '[]'::jsonb) || $6::jsonb,
            finished_at = CASE WHEN $7 THEN now() ELSE finished_at END
      WHERE id = $1`,
    [
      jobId,
      before.processed + processed,
      before.added + added,
      before.skipped + skipped,
      before.failed + failed,
      // The report is capped: a wholly failed 5000-track import should not
      // write a multi-megabyte JSONB row.
      JSON.stringify(report.slice(0, 200)),
      finished,
    ]
  );

  return { added, skipped, failed };
}

// Finds or creates a playlist by name. Re-importing the same playlist should
// update the existing one rather than making "My Mix (2)".
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
