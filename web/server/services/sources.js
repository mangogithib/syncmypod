import { many, one, query } from '../db/pool.js';
import * as deezer from '../providers/deezer.js';
import * as youtube from '../providers/youtube.js';
import { importSourceTracks } from './import.js';

// Standing sources: a playlist somewhere else that this library follows.
//
// An import happens once. Paste a link on the Import page and you get the
// playlist as it was that afternoon; a song added to it next week never
// arrives. A source is the same link, remembered, and re-read whenever the app
// is opened - so a playlist someone actually maintains stays the thing the iPod
// holds, without anyone pasting anything again.
//
// **Additive only.** A track removed upstream is not removed here. Same
// reasoning as the local app's ledger: the cost of being wrong is somebody's
// music, and "it disappeared from my library" is a far worse failure than "it
// is still there". Removing a source likewise leaves everything it imported.
//
// Metadata is unchanged from every other route - the resolver decides, and
// nothing a source claims is written unless a catalogue confirms it.

// Two readers, and adding a third means a module here and a case below rather
// than a schema change.
const KINDS = {
  'youtube-playlist': {
    label: 'YouTube playlist',
    module: youtube,
    parse: (input) => youtube.parsePlaylistRef(input),
    read: async (ref) => {
      const playlist = await youtube.getPlaylist(ref);
      return {
        name: playlist.name,
        artworkUrl: playlist.tracks[0]?.artworkUrl || null,
        // The video title is a hint. Splitting it here rather than in the
        // importer keeps every reader returning the same shape.
        tracks: playlist.tracks.map((entry) => ({
          title: entry.title,
          artist: entry.artist || null,
          durationMs: entry.durationMs,
          identity: entry.url,
          trusted: false,
        })),
      };
    },
  },
  'deezer-playlist': {
    label: 'Deezer playlist',
    module: deezer,
    parse: (input) => deezer.parsePlaylistRef(input),
    read: async (ref) => {
      const { playlist, tracks } = await deezer.getPlaylist(ref);
      return {
        name: playlist.name,
        artworkUrl: playlist.artworkUrl || null,
        tracks: tracks.map((track) => ({
          title: track.title,
          artist: track.artists?.[0]?.name || null,
          album: track.album?.name || null,
          durationMs: track.durationMs,
          deezerId: track.deezerId,
          identity: `deezer:${track.deezerId}`,
          // A Deezer playlist entry carries a real track id, so this is a
          // catalogue record rather than a guess and the resolver hydrates it
          // directly instead of searching.
          trusted: true,
        })),
      };
    },
  },
};

// How stale a source has to be before opening the app re-reads it.
//
// Half an hour. Long enough that clicking between pages costs nothing, short
// enough that a song added on a phone during lunch is on the iPod by evening.
const STALE_AFTER_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Adding and listing
// ---------------------------------------------------------------------------

// Works out what a pasted link is, checks it can actually be read, and keeps it.
//
// The read happens before the row is written, deliberately: a source that
// cannot be reached is a typo or a private playlist, and finding that out now -
// while the user is looking at the box they just pasted into - is far better
// than adding it and showing an error next to it forever.
export async function addSource(userId, input) {
  const text = String(input || '').trim();
  if (!text) throw new SourceError('Paste a playlist link first.');

  let kind = null;
  let ref = null;
  for (const [name, spec] of Object.entries(KINDS)) {
    const parsed = spec.parse(text);
    if (parsed) {
      kind = name;
      ref = parsed;
      break;
    }
  }

  if (!kind) {
    throw new SourceError(
      'That is not a playlist link this recognises. YouTube and Deezer playlists both work; paste the address from the browser.'
    );
  }

  let read;
  try {
    read = await KINDS[kind].read(ref);
  } catch (err) {
    throw new SourceError(err.message || 'That playlist could not be read.');
  }

  const row = await one(
    `INSERT INTO watched_sources (user_id, kind, ref, name, artwork_url, last_seen_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, kind, ref) DO UPDATE
        SET name = EXCLUDED.name,
            artwork_url = EXCLUDED.artwork_url,
            enabled = TRUE,
            last_error = NULL
     RETURNING id`,
    [userId, kind, ref, read.name, read.artworkUrl, read.tracks.length]
  );

  // Imported straight away rather than waiting for the next check. Adding a
  // source and seeing nothing happen would read as a failure.
  await checkSource(userId, row.id);
  return getSource(userId, row.id);
}

export async function listSources(userId) {
  return many(
    `SELECT s.id, s.kind, s.ref, s.name, s.artwork_url AS "artworkUrl",
            s.enabled, s.last_checked_at AS "lastCheckedAt",
            s.last_added AS "lastAdded", s.last_seen_count AS "lastSeenCount",
            s.last_error AS "lastError", s.created_at AS "createdAt",
            s.target_playlist_id AS "targetPlaylistId",
            p.name AS "targetPlaylistName"
       FROM watched_sources s
       LEFT JOIN playlists p ON p.id = s.target_playlist_id
      WHERE s.user_id = $1
   ORDER BY s.created_at DESC`,
    [userId]
  );
}

export async function getSource(userId, id) {
  const rows = await listSources(userId);
  return rows.find((row) => String(row.id) === String(id)) || null;
}

export async function setEnabled(userId, id, enabled) {
  const { rowCount } = await query(
    'UPDATE watched_sources SET enabled = $3 WHERE user_id = $1 AND id = $2',
    [userId, id, Boolean(enabled)]
  );
  return rowCount > 0;
}

// Forgets a source. Everything it imported stays, because those are library
// tracks now and deleting them is not what "stop following this" means.
export async function removeSource(userId, id) {
  const { rowCount } = await query(
    'DELETE FROM watched_sources WHERE user_id = $1 AND id = $2',
    [userId, id]
  );
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

// Re-reads one source and imports whatever is new.
export async function checkSource(userId, id) {
  const source = await one(
    `SELECT id, kind, ref, name, target_playlist_id AS "targetPlaylistId"
       FROM watched_sources WHERE user_id = $1 AND id = $2 AND enabled`,
    [userId, id]
  );
  if (!source) return null;

  const spec = KINDS[source.kind];
  if (!spec) return null;

  let read;
  try {
    read = await spec.read(source.ref);
  } catch (err) {
    // Recorded against the source rather than thrown. A playlist made private
    // should say so next to itself, where it can be acted on, and must not stop
    // the other sources being checked.
    await query(
      `UPDATE watched_sources
          SET last_error = $3, last_checked_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, id, String(err.message || 'Could not be read.').slice(0, 500)]
    );
    return { added: 0, error: err.message };
  }

  const jobId = await importSourceTracks(userId, {
    sourceId: source.id,
    sourceName: read.name || source.name,
    sourceRef: source.ref,
    kind: source.kind,
    targetPlaylistId: source.targetPlaylistId,
    tracks: read.tracks,
  });

  await query(
    `UPDATE watched_sources
        SET name = $3, last_checked_at = now(), last_seen_count = $4, last_error = NULL
      WHERE user_id = $1 AND id = $2`,
    [userId, id, read.name || source.name, read.tracks.length]
  );

  return { jobId, seen: read.tracks.length };
}

// Called when the app is opened.
//
// Only sources that have not been looked at recently, and never awaited by the
// caller - opening a page must not wait on somebody else's server. Failures are
// already recorded per source, so there is nothing here to catch beyond a
// programming error.
export async function checkDueSources(userId) {
  const due = await many(
    `SELECT id FROM watched_sources
      WHERE user_id = $1 AND enabled
        AND (last_checked_at IS NULL OR last_checked_at < now() - ($2 || ' milliseconds')::interval)
   ORDER BY last_checked_at NULLS FIRST
      LIMIT 10`,
    [userId, String(STALE_AFTER_MS)]
  );

  for (const source of due) {
    await checkSource(userId, source.id).catch((err) =>
      console.error(`[sources] check ${source.id} failed:`, err.message)
    );
  }
  return due.length;
}

// Records where a source's tracks land, so the next check adds to the same
// playlist instead of making a second one.
export async function rememberTarget(userId, sourceId, targetPlaylistId) {
  await query(
    `UPDATE watched_sources SET target_playlist_id = $3, last_added = $4
      WHERE user_id = $1 AND id = $2`,
    [userId, sourceId, targetPlaylistId || null, 0]
  );
}

export async function recordAdded(userId, sourceId, added) {
  await query('UPDATE watched_sources SET last_added = $3 WHERE user_id = $1 AND id = $2', [
    userId,
    sourceId,
    added,
  ]);
}

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
    this.status = 400;
  }
}

export const SOURCE_KINDS = Object.fromEntries(
  Object.entries(KINDS).map(([name, spec]) => [name, spec.label])
);
