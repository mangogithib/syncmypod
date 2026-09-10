import { many, one } from '../db/pool.js';
import { config } from '../config.js';

// The sync manifest: the contract between the web tool and the local app.
//
// This is the single most important interface in the project, so it is worth
// being precise about what it is and is not.
//
// IT IS: a complete statement of what the iPod should contain - track metadata,
// artwork URLs, playlist membership and order.
//
// IT IS NOT: audio, or a link to audio the server has. There is deliberately no
// download URL here. `searchTerms` and `sourceHint` are what the local app uses
// to go and find the audio itself, which is what keeps all downloading on the
// user's own machine and no media on the server.
//
// The local app diffs this against the iPod, downloads what is missing, tags it
// from these fields, writes it, and reports back.

export async function buildManifest(userId, deviceId) {
  const device = await one(
    `SELECT id, name, ipod_generation AS "ipodGeneration"
       FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId]
  );
  if (!device) return null;

  // Only resolved and manually-corrected tracks are eligible.
  //
  // This is the enforcement point for the concept's central rule: nothing gets
  // written to an iPod tagged from an unverified source title. A pending or
  // unresolved track is reported separately as `excluded` so the user can see
  // and fix it, rather than it vanishing silently.
  const tracks = await many(
    `SELECT t.id,
            t.title,
            t.artist_credit  AS "artist",
            t.album_credit   AS "album",
            t.track_no       AS "trackNo",
            t.disc_no        AS "discNo",
            t.duration_ms    AS "durationMs",
            t.isrc,
            t.genre,
            t.explicit,
            t.spotify_id     AS "spotifyId",
            t.mbid,
            al.artwork_url   AS "artworkUrl",
            al.release_year  AS "year",
            al.total_tracks  AS "totalTracks",
            aa.name          AS "albumArtist",
            lt.rating,
            lt.source_hint   AS "sourceHint",
            -- What the local app already has for this track, so it can skip work
            -- rather than re-deriving the diff from filenames.
            dt.state         AS "deviceState",
            dt.synced_at     AS "deviceSyncedAt",
            dt.format        AS "deviceFormat"
       FROM library_tracks lt
       JOIN tracks t   ON t.id = lt.track_id
  LEFT JOIN albums al  ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
  LEFT JOIN device_tracks dt ON dt.track_id = t.id AND dt.device_id = $2
      WHERE lt.user_id = $1
        AND t.metadata_state IN ('resolved', 'manual')
   ORDER BY lower(coalesce(aa.name, t.artist_credit)),
            lower(coalesce(al.name, '')),
            t.disc_no NULLS FIRST,
            t.track_no NULLS FIRST,
            lower(t.title)`,
    [userId, deviceId]
  );

  // Structured artists alongside the joined credit string. The local app writes
  // artist_credit into the tag, but having the list lets it populate an
  // ARTISTS-style multi-value frame where the format supports one.
  const artistRows = await many(
    `SELECT ta.track_id AS "trackId", a.name, ta.role, ta.position
       FROM library_tracks lt
       JOIN track_artists ta ON ta.track_id = lt.track_id
       JOIN artists a ON a.id = ta.artist_id
      WHERE lt.user_id = $1
   ORDER BY ta.track_id, ta.position`,
    [userId]
  );
  const artistsByTrack = new Map();
  for (const row of artistRows) {
    if (!artistsByTrack.has(row.trackId)) artistsByTrack.set(row.trackId, []);
    artistsByTrack.get(row.trackId).push({
      name: row.name,
      role: row.role,
      position: row.position,
    });
  }

  const playlists = await many(
    `SELECT p.id, p.name, p.description
       FROM playlists p
      WHERE p.user_id = $1 AND p.sync_to_ipod = TRUE
   ORDER BY lower(p.name)`,
    [userId]
  );

  // Playlist membership in one query rather than one per playlist. Entries whose
  // track is not in the library, or is unresolved, are filtered out here so the
  // local app never has to reason about a dangling reference.
  const playlistRows = await many(
    `SELECT pt.playlist_id AS "playlistId", pt.track_id AS "trackId", pt.position
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
       JOIN library_tracks lt ON lt.track_id = pt.track_id AND lt.user_id = p.user_id
       JOIN tracks t ON t.id = pt.track_id
      WHERE p.user_id = $1
        AND p.sync_to_ipod = TRUE
        AND t.metadata_state IN ('resolved', 'manual')
   ORDER BY pt.playlist_id, pt.position`,
    [userId]
  );
  const tracksByPlaylist = new Map();
  for (const row of playlistRows) {
    if (!tracksByPlaylist.has(row.playlistId)) tracksByPlaylist.set(row.playlistId, []);
    tracksByPlaylist.get(row.playlistId).push(row.trackId);
  }

  const excluded = await many(
    `SELECT t.id, t.title, t.artist_credit AS "artist", t.metadata_state AS "metadataState"
       FROM library_tracks lt
       JOIN tracks t ON t.id = lt.track_id
      WHERE lt.user_id = $1 AND t.metadata_state IN ('pending', 'unresolved')
   ORDER BY lower(t.title)
      LIMIT 500`,
    [userId]
  );

  return {
    // Bumped when the shape changes, so an old local app can refuse politely
    // rather than misinterpret a field.
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    device: {
      id: device.id,
      name: device.name,
      ipodGeneration: device.ipodGeneration,
    },
    // Conventions decided server-side, so every paired computer tags identically.
    conventions: {
      artistJoin: config.artistJoin,
      // The local app must re-tag from these fields and must not trust whatever
      // the download source embedded. Stated in the payload as well as the docs
      // because it is the rule the whole design rests on.
      retagFromManifest: true,
    },
    tracks: tracks.map((track) => ({
      ...track,
      artists: artistsByTrack.get(track.id) || [],
      // What to search for when looking for the audio. Built from resolved
      // metadata, never from the original source title - that is the point.
      searchTerms: buildSearchTerms(track),
    })),
    playlists: playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      trackIds: tracksByPlaylist.get(playlist.id) || [],
    })),
    excluded,
    counts: {
      tracks: tracks.length,
      playlists: playlists.length,
      excluded: excluded.length,
    },
  };
}

// The query the local app should use to find the audio. Resolved artist and
// title, nothing else: no "official video", no source-supplied noise.
function buildSearchTerms(track) {
  const primary = [track.artist, track.title].filter(Boolean).join(' - ');
  return {
    primary,
    // A second, album-qualified attempt for the case where the plain query
    // returns a cover or a live version.
    withAlbum: [track.artist, track.title, track.album].filter(Boolean).join(' '),
    isrc: track.isrc || null,
    durationMs: track.durationMs || null,
  };
}

// Records what the local app reports after a sync.
//
// The server does not verify these claims - it cannot see the iPod. The local
// app is the authority on what is physically on the device, and this is the
// bookkeeping that lets the next manifest skip what is already there.
export async function recordSyncResults(deviceId, results) {
  let synced = 0;
  let failed = 0;

  for (const result of results) {
    const trackId = Number(result.trackId);
    if (!Number.isInteger(trackId)) continue;

    const state = ['synced', 'failed', 'skipped', 'removed'].includes(result.state)
      ? result.state
      : 'failed';
    if (state === 'synced') synced++;
    if (state === 'failed') failed++;

    await one(
      `INSERT INTO device_tracks
         (device_id, track_id, state, synced_at, file_size, bitrate, format, source_used, error, attempts)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'synced' THEN now() ELSE NULL END,
               $4, $5, $6, $7, $8, 1)
       ON CONFLICT (device_id, track_id) DO UPDATE
          SET state       = EXCLUDED.state,
              synced_at   = COALESCE(EXCLUDED.synced_at, device_tracks.synced_at),
              file_size   = COALESCE(EXCLUDED.file_size, device_tracks.file_size),
              bitrate     = COALESCE(EXCLUDED.bitrate, device_tracks.bitrate),
              format      = COALESCE(EXCLUDED.format, device_tracks.format),
              source_used = COALESCE(EXCLUDED.source_used, device_tracks.source_used),
              error       = EXCLUDED.error,
              -- Counts retries, so a track that fails every time is visible as a
              -- persistent problem rather than looking like a one-off.
              attempts    = device_tracks.attempts + 1
       RETURNING device_id`,
      [
        deviceId,
        trackId,
        state,
        result.fileSize ?? null,
        result.bitrate ?? null,
        result.format ?? null,
        result.sourceUsed ?? null,
        result.error ? String(result.error).slice(0, 2000) : null,
      ]
    );
  }

  return { synced, failed, recorded: results.length };
}
