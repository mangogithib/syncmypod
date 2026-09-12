import { one, query, transaction } from '../db/pool.js';
import * as deezer from '../providers/deezer.js';
import * as youtube from '../providers/youtube.js';
import * as youtubeAccount from './youtube-account.js';
import { appendToPlaylist } from './playlist-writes.js';
import { resolveAndSave } from './resolver.js';

// Bulk-importing tracks into the library.
//
// Four sources:
//
//   deezer-playlist   a public Deezer playlist, by URL or id
//   youtube-playlist  a public YouTube playlist, by URL or id
//   track-list        pasted text, one track per line
//   youtube-account   the playlists a connected YouTube account has been asked
//                     to follow, re-checked when the app is opened
//
// Only the last needs an account, because reading somebody's own playlists
// needs their permission. The other three need nothing at all, which is a
// property worth keeping.
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

export async function startDeezerPlaylistImport(userId, playlistRef, options = {}) {
  const playlistId = deezer.parsePlaylistRef(playlistRef);
  if (!playlistId) {
    throw new Error(
      'That does not look like a Deezer playlist. Paste the playlist URL, or just its numeric id.'
    );
  }

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, status, target_playlist_id)
     VALUES ($1, 'deezer-playlist', $2, 'queued', $3)
     RETURNING id`,
    [userId, playlistId, options.targetPlaylistId || null]
  );

  // Deliberately not awaited: the caller returns the job id straight away.
  // The catch is essential - an unhandled rejection here would take the process
  // down and lose every other job with it.
  runJob(job.id, () => importDeezerPlaylist(job.id, userId, playlistId, options)).catch(
    (err) => console.error(`[import] job ${job.id} crashed:`, err.message)
  );

  return job.id;
}

// A public YouTube playlist.
//
// The metadata rule is the same one the YouTube search button follows, applied
// to a whole playlist at once: nothing YouTube says about a track is written to
// the library unless a real catalogue agrees with it.
//
// So each entry is cross-checked. The video title is split into a rough artist
// and title, and that guess - plus the duration, which is the strongest signal
// available and is why live streams are dropped when reading the playlist - is
// put to Deezer, iTunes and MusicBrainz in turn. A confident match means the
// track is stored with the catalogue's artist, album, artwork and ISRC, exactly
// as if it had been added from a search.
//
// A track no catalogue knows keeps its title and nothing else. Not the channel
// name as an artist, not the video title as an album. Those are the tracks that
// show up needing attention, and they are the ones that genuinely only exist on
// YouTube - which is the case this whole path is for.
export async function startYouTubePlaylistImport(userId, playlistRef, options = {}) {
  const playlistId = youtube.parsePlaylistRef(playlistRef);
  if (!playlistId) {
    throw new Error(
      'That does not look like a YouTube playlist. Paste the playlist link, or just the part after "list=".'
    );
  }

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, status, target_playlist_id)
     VALUES ($1, 'youtube-playlist', $2, 'queued', $3)
     RETURNING id`,
    [userId, playlistId, options.targetPlaylistId || null]
  );

  runJob(job.id, () => importYouTubePlaylist(job.id, userId, playlistId, options)).catch(
    (err) => console.error(`[import] job ${job.id} crashed:`, err.message)
  );

  return job.id;
}

// Re-checks every playlist a connected YouTube account has been asked to follow.
//
// Called when the app is opened, and by the Sync now button. One job covers all
// the selected playlists rather than one job each, because the question being
// asked is "is my library up to date" and that has a single answer.
//
// A track already in the library is counted as skipped and costs nothing beyond
// the resolver's own dedupe, so a re-run over an unchanged playlist is cheap.
// Cheap, not free - the YouTube API calls still happen, against a daily quota -
// which is why the open-the-app path below only runs when something is stale.
export async function startYouTubeAccountSync(userId) {
  const followed = (await youtubeAccount.listPlaylists(userId)).filter((p) => p.selected);
  if (followed.length === 0) {
    throw new Error('No playlists are selected yet. Tick the ones you want to follow.');
  }

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_name, status)
     VALUES ($1, 'youtube-account', $2, 'queued')
     RETURNING id`,
    [userId, followed.length === 1 ? followed[0].title : `${followed.length} YouTube playlists`]
  );

  runJob(job.id, () => syncYouTubeAccount(job.id, userId, followed)).catch((err) =>
    console.error(`[import] job ${job.id} crashed:`, err.message)
  );

  return job.id;
}

// The open-the-app path.
//
// Runs a sync only if one has not run recently, so opening the page five times
// in a minute does not mean five passes over the YouTube API.
const STALE_AFTER_MS = 30 * 60_000;
const lastRun = new Map();

export async function syncYouTubeAccountIfStale(userId) {
  const previous = lastRun.get(userId) || 0;
  if (Date.now() - previous < STALE_AFTER_MS) return null;
  lastRun.set(userId, Date.now());
  try {
    return await startYouTubeAccountSync(userId);
  } catch {
    // Nothing selected, or the account is gone. Opening the page must not fail
    // because a background convenience could not run.
    return null;
  }
}

async function syncYouTubeAccount(jobId, userId, followed) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  // Every followed playlist is read before any is imported, so `total` is the
  // real number from the start and the progress bar means something instead of
  // jumping each time another playlist is fetched.
  const work = [];
  for (const playlist of followed) {
    const items = await youtubeAccount.playlistItems(userId, playlist.youtubeId);
    work.push({ playlist, items });
  }

  const total = work.reduce((sum, entry) => sum + entry.items.length, 0);
  await query(`UPDATE import_jobs SET total = $2 WHERE id = $1`, [jobId, total]);

  const carried = { processed: 0, added: 0, skipped: 0, failed: 0 };

  for (const { playlist, items } of work) {
    let targetPlaylistId = playlist.targetPlaylistId;
    if (!targetPlaylistId) {
      targetPlaylistId = await ensurePlaylist(userId, playlist.title, {
        source: 'youtube',
        sourceRef: playlist.youtubeId,
      });
    }

    // The same rule as a pasted playlist link: the video title is a search, the
    // catalogue is the metadata, and a track nothing recognises keeps its title
    // and nothing else.
    const counts = await processItems(
      jobId,
      userId,
      items.map((item) => ({
        ...splitYouTubeTitle(item),
        matchKeyExtra: item.videoId
          ? `https://www.youtube.com/watch?v=${item.videoId}`
          : null,
      })),
      {
        targetPlaylistId,
        addedVia: 'youtube-account',
        discardUnverifiedMetadata: true,
        // Several playlists share one job, so each pass reports against the
        // job's totals rather than restarting at zero.
        carried,
        jobTotal: total,
      }
    );

    carried.processed += items.length;
    carried.added += counts.added;
    carried.skipped += counts.skipped;
    carried.failed += counts.failed;

    await youtubeAccount.markSynced(userId, playlist.youtubeId, {
      itemCount: items.length,
      targetPlaylistId,
    });
  }
}

// Imports one playlist that the local app read and pushed here.
//
// The local app has the YouTube session, so it does the reading; this does the
// resolving, which is the half that has to happen server-side because it is the
// server that owns the catalogue and the library.
//
// Identical treatment to every other YouTube route: the video title is a
// search, the catalogue is the metadata, and a track nothing recognises keeps
// its title and nothing else.
export async function importPushedYouTubePlaylist(userId, playlist, entries) {
  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_ref, source_name, status, total)
     VALUES ($1, 'youtube-account', $2, $3, 'queued', $4)
     RETURNING id`,
    [userId, playlist.youtubeId, playlist.title, entries.length]
  );

  runJob(job.id, async () => {
    await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [job.id]);

    let targetPlaylistId = playlist.targetPlaylistId || null;
    if (!targetPlaylistId) {
      targetPlaylistId = await ensurePlaylist(userId, playlist.title, {
        source: 'youtube',
        sourceRef: playlist.youtubeId,
      });
    }

    await processItems(
      job.id,
      userId,
      entries.map((entry) => ({
        ...splitYouTubeTitle(entry),
        durationMs: entry.durationMs || null,
        matchKeyExtra: entry.videoId
          ? `https://www.youtube.com/watch?v=${entry.videoId}`
          : null,
      })),
      {
        targetPlaylistId,
        addedVia: 'youtube-account',
        discardUnverifiedMetadata: true,
      }
    );

    await youtubeAccount.markSynced(userId, playlist.youtubeId, {
      itemCount: entries.length,
      targetPlaylistId,
    });
  }).catch((err) => console.error(`[import] job ${job.id} crashed:`, err.message));

  return job.id;
}

// The API gives a video title and an uploader. Turned into the same rough
// {title, artist} guess the scraped-playlist path produces, using the same
// splitter, so both routes resolve identically.
function splitYouTubeTitle(item) {
  const guess = youtube.splitArtistTitle(item.title, item.channel || '');
  return { title: guess.title || item.title, artist: guess.artist || null };
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

async function importDeezerPlaylist(jobId, userId, playlistId, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  const { playlist, tracks } = await deezer.getPlaylist(playlistId);

  await query(`UPDATE import_jobs SET total = $2, source_name = $3 WHERE id = $1`, [
    jobId,
    tracks.length,
    playlist.name,
  ]);

  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist !== false) {
    targetPlaylistId = await ensurePlaylist(userId, playlist.name, {
      description: playlist.description,
      source: 'deezer',
      sourceRef: playlist.deezerId,
    });
    await query('UPDATE import_jobs SET target_playlist_id = $2 WHERE id = $1', [
      jobId,
      targetPlaylistId,
    ]);
  }

  // Playlist entries already carry a Deezer track id, so resolution is a direct
  // hydrate rather than a search. That is what makes a large playlist fast.
  await processItems(
    jobId,
    userId,
    tracks.map((track) => ({
      deezerId: track.deezerId,
      title: track.title,
      artist: track.artists?.[0]?.name || null,
      album: track.album?.name || null,
      durationMs: track.durationMs,
    })),
    { targetPlaylistId, addedVia: 'deezer-import' }
  );
}

async function importYouTubePlaylist(jobId, userId, playlistId, options) {
  await query(`UPDATE import_jobs SET status = 'running' WHERE id = $1`, [jobId]);

  const playlist = await youtube.getPlaylist(playlistId);

  await query(`UPDATE import_jobs SET total = $2, source_name = $3 WHERE id = $1`, [
    jobId,
    playlist.tracks.length,
    playlist.name,
  ]);

  let targetPlaylistId = options.targetPlaylistId || null;
  if (!targetPlaylistId && options.createPlaylist !== false) {
    targetPlaylistId = await ensurePlaylist(userId, playlist.name, {
      source: 'youtube',
      sourceRef: playlist.id,
    });
    await query('UPDATE import_jobs SET target_playlist_id = $2 WHERE id = $1', [
      jobId,
      targetPlaylistId,
    ]);
  }

  await processItems(
    jobId,
    userId,
    playlist.tracks.map((entry) => ({
      // The guess, offered to the resolver as a search - never stored as-is.
      title: entry.title,
      artist: entry.artist || null,
      durationMs: entry.durationMs,
      // Keeps two different videos with the same title apart when neither
      // resolves, since both will have an empty artist by then.
      matchKeyExtra: entry.url,
    })),
    {
      targetPlaylistId,
      addedVia: 'youtube-import',
      discardUnverifiedMetadata: true,
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
