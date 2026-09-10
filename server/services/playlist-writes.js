import { query } from '../db/pool.js';

// Playlist mutations that more than one caller needs.
//
// It lives in services/ rather than in the playlists route because the import
// service and the artist-follow sweep both append to playlists without going
// anywhere near HTTP. A route importing another route to reuse a helper is how
// circular imports start.

// Appends a track to the end of a playlist.
//
// Positions are sparse (10, 20, 30...) so a later insert between two tracks is
// a single UPDATE rather than a renumbering of everything after it.
export async function appendToPlaylist(playlistId, trackId) {
  const { rowCount } = await query(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position)
     SELECT $1, $2, COALESCE(max(position), 0) + 10
       FROM playlist_tracks WHERE playlist_id = $1
     ON CONFLICT (playlist_id, track_id) DO NOTHING`,
    [playlistId, trackId]
  );
  // Only bump the timestamp when something actually changed, so re-running an
  // import does not make every playlist look freshly edited.
  if (rowCount > 0) {
    await query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlistId]);
  }
  return rowCount > 0;
}
