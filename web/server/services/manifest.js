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
  // The central rule, and the one place it is enforced: nothing is written to an
  // iPod tagged from an unverified source title.
  //
  // **That is not the same as refusing to write the track.** Holding an
  // unresolved track back entirely would mean a song somebody deliberately
  // added never reaches the device, with no remedy but typing an artist in by
  // hand. The song goes on; the fields nobody could confirm go on empty.
  //
  // An unresolved row already stores an empty artist and a null album - see
  // saveUnresolvedTrack - so including it here writes exactly those. The iPod
  // files it under "Unknown Artist", which is honest, visible, and fixable
  // later by filling the metadata in and syncing again.
  //
  // `pending` is still held back. That means resolution has not been attempted
  // yet rather than attempted and failed, so it is a race rather than a result.
  const tracks = await many(
    `SELECT t.id,
            t.title,
            t.artist_credit  AS "artist",
            -- The resolved album name, falling back to whatever the source
            -- called it. The two agree today, and the order still matters:
            -- album_credit is an unverified string where albums.name is the
            -- resolved fact, and the whole design is that the resolved fact is
            -- what gets written. The album string is also the key an iPod
            -- groups by, so a track carrying a different spelling of its own
            -- album becomes a second album on the device.
            coalesce(al.name, t.album_credit) AS "album",
            t.track_no       AS "trackNo",
            t.disc_no        AS "discNo",
            t.duration_ms    AS "durationMs",
            t.isrc,
            t.genre,
            t.explicit,
            t.mbid,
            -- Whether this album's tracks disagree about who the artist is.
            --
            -- This is what iTunes calls "Part of a compilation", and it is the
            -- switch that decides how an iPod files a multi-artist album. With
            -- it off, the device groups by album AND artist, so a soundtrack
            -- with eight singers becomes eight albums in Cover Flow - measured
            -- on a real 7th gen Classic, where the album list was correct and
            -- the carousel was not. With it on, the album is one album.
            --
            -- Counted across the tracks this user actually holds, which is the
            -- honest scope: it is their library that gets written to their
            -- iPod. Adding a second artist's track to an album flips it, and
            -- the next sync corrects what is already on the device.
            --
            -- An unresolved track carries an empty artist credit, and an
            -- unknown artist is not evidence of a second one - so blanks are
            -- excluded from the count below. Without that, a single song whose
            -- metadata nobody could confirm turned its whole album into a
            -- compilation on the device, which is exactly the grouping this
            -- flag exists to fix.
            (coalesce(credits.artists, 1) > 1) AS "compilation",
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
       -- How many different artists this user's copy of the album names.
       --
       -- A join rather than a window function: Postgres has no
       -- count(DISTINCT ...) OVER (...), and one grouped pass over the
       -- library is cheaper than a correlated subquery per track anyway.
  LEFT JOIN (
         SELECT t2.album_id,
                count(DISTINCT nullif(btrim(t2.artist_credit), '')) AS artists
           FROM library_tracks lt2
           JOIN tracks t2 ON t2.id = lt2.track_id
          WHERE lt2.user_id = $1 AND t2.album_id IS NOT NULL
       GROUP BY t2.album_id
       ) credits ON credits.album_id = t.album_id
      WHERE lt.user_id = $1
        AND t.metadata_state IN ('resolved', 'manual', 'unresolved')
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
  // track is not in the library, or has not been resolved yet, are filtered out
  // here so the local app never has to reason about a dangling reference. The
  // state list matches the track query above exactly - a song on the device but
  // missing from its playlist would be a worse bug than either.
  const playlistRows = await many(
    `SELECT pt.playlist_id AS "playlistId", pt.track_id AS "trackId", pt.position
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
       JOIN library_tracks lt ON lt.track_id = pt.track_id AND lt.user_id = p.user_id
       JOIN tracks t ON t.id = pt.track_id
      WHERE p.user_id = $1
        AND p.sync_to_ipod = TRUE
        AND t.metadata_state IN ('resolved', 'manual', 'unresolved')
   ORDER BY pt.playlist_id, pt.position`,
    [userId]
  );
  const tracksByPlaylist = new Map();
  for (const row of playlistRows) {
    if (!tracksByPlaylist.has(row.playlistId)) tracksByPlaylist.set(row.playlistId, []);
    tracksByPlaylist.get(row.playlistId).push(row.trackId);
  }

  // Only what is genuinely held back, which is now just `pending`. An
  // unresolved track syncs with empty fields rather than being excluded, so
  // listing it here would tell the user it had been skipped when it had not.
  const excluded = await many(
    `SELECT t.id, t.title, t.artist_credit AS "artist", t.metadata_state AS "metadataState"
       FROM library_tracks lt
       JOIN tracks t ON t.id = lt.track_id
      WHERE lt.user_id = $1 AND t.metadata_state = 'pending'
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
  const rejected = [];

  for (const result of results) {
    const trackId = Number(result.trackId);
    if (!Number.isInteger(trackId)) {
      rejected.push({ trackId: result.trackId ?? null, reason: 'Not a track id.' });
      continue;
    }

    const state = ['synced', 'failed', 'skipped', 'removed'].includes(result.state)
      ? result.state
      : 'failed';

    // One bad row must not take the batch with it.
    //
    // A batch is up to 500 results and each row is its own statement, so an
    // exception halfway through left the earlier rows committed and answered
    // the whole request with a 500 - and the local app, told the batch failed,
    // has no way to know which half landed. The realistic cause is ordinary:
    // a song removed from the library while the sync that was writing it ran,
    // leaving a foreign key with nothing to point at.
    //
    // So each row stands alone and the rejects are named in the reply.
    try {
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
                -- Counts retries, so a track that fails every time is visible as
                -- a persistent problem rather than looking like a one-off.
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
      if (state === 'synced') synced++;
      if (state === 'failed') failed++;
    } catch (err) {
      // Counted after the write, not before, so the totals describe what was
      // actually recorded rather than what was attempted.
      rejected.push({ trackId, reason: 'Could not be recorded.' });
      console.warn(
        `[sync] device ${deviceId} track ${trackId}: result not recorded - ${err.message}`
      );
    }
  }

  return {
    synced,
    failed,
    recorded: results.length - rejected.length,
    ...(rejected.length > 0 ? { rejected } : {}),
  };
}
