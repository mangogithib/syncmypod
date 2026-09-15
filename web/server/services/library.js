import { many, one } from '../db/pool.js';

// Reading the library.
//
// Every list of tracks in the UI - the library, a playlist, an album, an
// artist's songs - wants the same columns joined the same way. That query lives
// here once so the shape the frontend receives is identical everywhere and a
// change to it is a change in one place.

// The projection shared by every track list. Album and artist come from joins
// rather than from tracks.artist_credit alone, because the UI needs the ids to
// link with, while artist_credit is what would be written to the iPod tag.
const TRACK_COLUMNS = `
  t.id,
  t.title,
  t.artist_credit          AS "artistCredit",
  t.album_credit           AS "albumCredit",
  t.track_no               AS "trackNo",
  t.disc_no                AS "discNo",
  t.duration_ms            AS "durationMs",
  t.isrc,
  t.mbid,
  t.explicit,
  t.metadata_state         AS "metadataState",
  t.metadata_source        AS "metadataSource",
  al.id                    AS "albumId",
  al.name                  AS "albumName",
  al.artwork_url           AS "artworkUrl",
  al.release_year          AS "releaseYear",
  lt.added_at              AS "addedAt",
  lt.added_via             AS "addedVia",
  lt.rating,
  lt.source_hint           AS "sourceHint",
  lt.attention_dismissed   AS "attentionDismissed",
  fail.error               AS "syncError",
  fail.device_name         AS "syncFailedOn"
`;

// Whether the local app could not put this track on a paired computer's iPod.
//
// The local app has always reported a failure per track and the server has
// always stored it; nothing showed it, so the only way to find out a song never
// reached the device was to go looking in the database. A track can be on
// several devices and fail on one, so this reports the most recent failure on
// any device still paired - which is the question being asked ("did my last
// sync get everything?") rather than a per-device matrix nobody wants.
//
// A LATERAL rather than a join: it must not multiply rows when a track is on
// two devices, and the failure that matters is the newest one.
const SYNC_FAILURE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT dt.error, d.name AS device_name
      FROM device_tracks dt
      JOIN devices d ON d.id = dt.device_id
     WHERE dt.track_id = t.id
       AND d.user_id = lt.user_id
       AND d.revoked_at IS NULL
       AND dt.state = 'failed'
  ORDER BY dt.synced_at DESC NULLS LAST
     LIMIT 1
  ) fail ON TRUE`;

const SORTS = {
  added: 'lt.added_at DESC NULLS LAST, t.id DESC',
  title: 'lower(t.title) ASC, t.id ASC',
  artist: 'lower(t.artist_credit) ASC, lower(t.title) ASC',
  album: 'lower(coalesce(al.name, t.album_credit, \'\')) ASC, t.disc_no NULLS FIRST, t.track_no NULLS FIRST',
  year: 'al.release_year DESC NULLS LAST, lower(t.title) ASC',
  duration: 't.duration_ms DESC NULLS LAST',
};

// Lists tracks in a user's library with optional filtering.
//
// Filters are built into a parameter array rather than interpolated, and the
// sort is chosen from the SORTS map above, so nothing from the query string
// reaches the SQL text.
export async function listLibraryTracks(userId, options = {}) {
  const {
    search,
    albumId,
    artistId,
    metadataState,
    playlistId,
    limit = 50,
    offset = 0,
    sort = 'added',
  } = options;

  const params = [userId];
  const where = ['lt.user_id = $1'];

  if (search) {
    params.push(`%${search}%`);
    const like = `$${params.length}`;
    // ILIKE across the three fields a person actually searches by. A GIN index
    // backs the tsvector path used by /api/search; this one is the substring
    // fallback, which matters because "bohem" should match "Bohemian Rhapsody"
    // and full-text search will not do that on a partial word.
    where.push(
      `(t.title ILIKE ${like} OR t.artist_credit ILIKE ${like} OR al.name ILIKE ${like})`
    );
  }
  if (albumId) {
    params.push(albumId);
    where.push(`t.album_id = $${params.length}`);
  }
  if (artistId) {
    params.push(artistId);
    where.push(
      `EXISTS (SELECT 1 FROM track_artists ta
                WHERE ta.track_id = t.id AND ta.artist_id = $${params.length})`
    );
  }
  if (metadataState === 'sync-failed') {
    // Not a metadata state at all, but it shares the one filter control on the
    // Songs page because both answer "which songs need looking at".
    where.push('fail.error IS NOT NULL');
  } else if (metadataState) {
    params.push(metadataState);
    where.push(`t.metadata_state = $${params.length}`);
  }
  if (playlistId) {
    params.push(playlistId);
    where.push(
      `EXISTS (SELECT 1 FROM playlist_tracks pt
                WHERE pt.track_id = t.id AND pt.playlist_id = $${params.length})`
    );
  }

  const orderBy = SORTS[sort] || SORTS.added;

  params.push(limit, offset);
  const rows = await many(
    `SELECT ${TRACK_COLUMNS}
       FROM library_tracks lt
       JOIN tracks t  ON t.id = lt.track_id
  LEFT JOIN albums al ON al.id = t.album_id
       ${SYNC_FAILURE_JOIN}
      WHERE ${where.join(' AND ')}
   ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // The count reuses the same WHERE with the limit/offset parameters dropped, so
  // the total can never disagree with the page the user is looking at.
  const countParams = params.slice(0, -2);
  const total = await one(
    `SELECT count(*)::int AS count
       FROM library_tracks lt
       JOIN tracks t  ON t.id = lt.track_id
  LEFT JOIN albums al ON al.id = t.album_id
       ${SYNC_FAILURE_JOIN}
      WHERE ${where.join(' AND ')}`,
    countParams
  );

  return { tracks: rows, total: total.count, limit, offset };
}

export async function getTrack(userId, trackId) {
  const track = await one(
    `SELECT ${TRACK_COLUMNS},
            t.created_at  AS "createdAt",
            t.resolved_at AS "resolvedAt",
            (lt.user_id IS NOT NULL) AS "inLibrary"
       FROM tracks t
  LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN library_tracks lt ON lt.track_id = t.id AND lt.user_id = $1
      WHERE t.id = $2`,
    [userId, trackId]
  );
  if (!track) return null;

  track.artists = await many(
    `SELECT a.id, a.name, a.mbid,
            a.image_url AS "imageUrl", ta.role, ta.position
       FROM track_artists ta
       JOIN artists a ON a.id = ta.artist_id
      WHERE ta.track_id = $1
   ORDER BY ta.position, a.name`,
    [trackId]
  );

  track.playlists = await many(
    `SELECT p.id, p.name
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
      WHERE pt.track_id = $1 AND p.user_id = $2
   ORDER BY lower(p.name)`,
    [trackId, userId]
  );

  return track;
}

// Albums represented in the library, with how many of their tracks are actually
// present. "7 of 12" is the useful number when deciding what to fill in.
// The tracks in this user's library matching any of these identities.
//
// Used by the artist and album pages to tell "already yours" from "new". Both
// halves of the OR matter: `match_key` catches the common case, and the ISRC
// column catches a track stored under a provider id that is now being offered
// with an ISRC, or the reverse.
export async function knownTracks(userId, { keys, isrcs }) {
  if ((keys?.length ?? 0) === 0 && (isrcs?.length ?? 0) === 0) return [];
  return many(
    `SELECT DISTINCT t.id, t.match_key AS "matchKey", t.isrc
       FROM library_tracks lt
       JOIN tracks t ON t.id = lt.track_id
      WHERE lt.user_id = $1
        AND (t.match_key = ANY($2::text[]) OR (t.isrc IS NOT NULL AND t.isrc = ANY($3::text[])))`,
    [userId, keys || [], isrcs || []]
  );
}

export async function listAlbums(userId, { search, limit = 60, offset = 0 } = {}) {
  const params = [userId];
  const where = ['lt.user_id = $1'];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(al.name ILIKE $${params.length} OR aa.name ILIKE $${params.length})`);
  }

  params.push(limit, offset);
  const albums = await many(
    `SELECT al.id,
            al.name,
            al.artwork_url   AS "artworkUrl",
            al.release_year  AS "releaseYear",
            al.total_tracks  AS "totalTracks",
            al.album_type    AS "albumType",
            -- So a library album tile can open the same album page a search
            -- result opens, instead of a modal that only knows what you have.
            al.deezer_id     AS "deezerId",
            aa.id            AS "artistId",
            aa.name          AS "artistName",
            count(t.id)::int AS "trackCount"
       FROM library_tracks lt
       JOIN tracks t   ON t.id = lt.track_id
       JOIN albums al  ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
      WHERE ${where.join(' AND ')}
   GROUP BY al.id, aa.id
   ORDER BY lower(al.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await one(
    `SELECT count(DISTINCT al.id)::int AS count
       FROM library_tracks lt
       JOIN tracks t  ON t.id = lt.track_id
       JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
      WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  );

  return { albums, total: total.count, limit, offset };
}

// Artists represented in the library. Counts every credit, primary or featured,
// which is the behaviour that makes a featured-artist tag worth having.
export async function listArtists(userId, { search, limit = 100, offset = 0 } = {}) {
  const params = [userId];
  const where = ['lt.user_id = $1'];
  if (search) {
    params.push(`%${search}%`);
    where.push(`a.name ILIKE $${params.length}`);
  }

  params.push(limit, offset);
  const artists = await many(
    `SELECT a.id,
            a.name,
            a.image_url  AS "imageUrl",
            count(DISTINCT t.id)::int AS "trackCount",
            count(DISTINCT t.album_id)::int AS "albumCount",
            (fa.user_id IS NOT NULL) AS "followed"
       FROM library_tracks lt
       JOIN tracks t        ON t.id = lt.track_id
       JOIN track_artists ta ON ta.track_id = t.id
       JOIN artists a       ON a.id = ta.artist_id
  LEFT JOIN followed_artists fa ON fa.artist_id = a.id AND fa.user_id = lt.user_id
      WHERE ${where.join(' AND ')}
   GROUP BY a.id, fa.user_id
   ORDER BY lower(a.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await one(
    `SELECT count(DISTINCT a.id)::int AS count
       FROM library_tracks lt
       JOIN tracks t         ON t.id = lt.track_id
       JOIN track_artists ta ON ta.track_id = t.id
       JOIN artists a        ON a.id = ta.artist_id
      WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  );

  return { artists, total: total.count, limit, offset };
}

// Everything the dashboard shows, in one round trip rather than six.
export async function libraryStats(userId) {
  const row = await one(
    `SELECT
       (SELECT count(*)::int FROM library_tracks WHERE user_id = $1) AS "trackCount",
       (SELECT count(DISTINCT t.album_id)::int
          FROM library_tracks lt JOIN tracks t ON t.id = lt.track_id
         WHERE lt.user_id = $1 AND t.album_id IS NOT NULL) AS "albumCount",
       (SELECT count(DISTINCT ta.artist_id)::int
          FROM library_tracks lt
          JOIN track_artists ta ON ta.track_id = lt.track_id
         WHERE lt.user_id = $1) AS "artistCount",
       (SELECT count(*)::int FROM playlists WHERE user_id = $1) AS "playlistCount",
       (SELECT count(*)::int FROM followed_artists WHERE user_id = $1) AS "followedCount",
       (SELECT coalesce(sum(t.duration_ms), 0)::bigint
          FROM library_tracks lt JOIN tracks t ON t.id = lt.track_id
         WHERE lt.user_id = $1) AS "totalDurationMs",
       (SELECT count(*)::int
          FROM library_tracks lt JOIN tracks t ON t.id = lt.track_id
         WHERE lt.user_id = $1
           AND t.metadata_state IN ('pending', 'unresolved')
           -- Tracks the user has looked at and accepted as they are. They still
           -- sync and still read as unresolved in the Songs list; they just stop
           -- being counted, so the warning keeps meaning something.
           AND NOT lt.attention_dismissed)
         AS "needsAttention",
       -- Tracks the local app could not put on a paired iPod. Counted here so
       -- the overview can say so: the sync knows, the server has always stored
       -- it, and until now the only way to find out was to look in the database.
       (SELECT count(DISTINCT dt.track_id)::int
          FROM device_tracks dt
          JOIN devices d ON d.id = dt.device_id
         WHERE d.user_id = $1 AND d.revoked_at IS NULL AND dt.state = 'failed')
         AS "syncFailed"`,
    [userId]
  );
  return row;
}
