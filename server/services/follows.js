import { many, one, query } from '../db/pool.js';
import * as spotify from '../providers/spotify.js';
import { appendToPlaylist } from './playlist-writes.js';
import { resolveAndSave } from './resolver.js';

// Favourite-artist auto-follow.
//
// Follow an artist and their new releases land in the library on their own. The
// mechanism is deliberately simple: list the artist's releases, compare against
// what has already been seen, act on the difference.
//
// The seen-set is what makes this safe. Without it, the first check after
// following would classify the artist's entire back catalogue as "new" and add
// several hundred tracks to someone's 160GB iPod unannounced. So following an
// artist records a baseline first and adds nothing.

// Checks one followed artist for new releases.
//
// baselineOnly records what exists today without adding any of it - used when a
// follow is first created.
export async function checkFollowedArtist(userId, artistId, { baselineOnly = false } = {}) {
  const follow = await one(
    `SELECT fa.auto_add            AS "autoAdd",
            fa.include_singles     AS "includeSingles",
            fa.include_compilations AS "includeCompilations",
            fa.target_playlist_id  AS "targetPlaylistId",
            a.name,
            a.spotify_id           AS "spotifyId"
       FROM followed_artists fa
       JOIN artists a ON a.id = fa.artist_id
      WHERE fa.user_id = $1 AND fa.artist_id = $2`,
    [userId, artistId]
  );
  if (!follow) return { checked: false, reason: 'Not following that artist.' };

  // Release discovery needs Spotify: MusicBrainz has no equivalent "everything
  // by this artist, newest first" endpoint that is cheap enough to poll.
  if (!follow.spotifyId || !spotify.isEnabled()) {
    return {
      checked: false,
      reason: follow.spotifyId
        ? 'Spotify is not configured, so new releases cannot be discovered.'
        : 'This artist has no Spotify id, so new releases cannot be discovered.',
    };
  }

  const groups = ['album'];
  if (follow.includeSingles) groups.push('single');
  if (follow.includeCompilations) groups.push('compilation');

  let releases;
  try {
    releases = await spotify.getArtistAlbums(follow.spotifyId, {
      includeGroups: groups.join(','),
    });
  } catch (err) {
    await touchChecked(userId, artistId);
    return { checked: false, reason: `Spotify lookup failed: ${err.message}` };
  }

  const seenRows = await many(
    'SELECT release_key FROM artist_release_seen WHERE user_id = $1 AND artist_id = $2',
    [userId, artistId]
  );
  const seen = new Set(seenRows.map((row) => row.release_key));

  // Keyed by Spotify album id, falling back to name+year. The fallback matters
  // because the same album is often re-released under a new id in a different
  // market, and adding it twice is worse than missing it.
  const keyed = releases.map((release) => ({
    release,
    key: release.spotifyId
      ? `sp:${release.spotifyId}`
      : `n:${release.name.toLowerCase()}:${release.releaseYear || '?'}`,
  }));

  const fresh = keyed.filter((entry) => !seen.has(entry.key));

  if (baselineOnly) {
    await markSeen(userId, artistId, keyed.map((entry) => entry.key));
    await touchChecked(userId, artistId);
    return {
      checked: true,
      baseline: true,
      knownReleases: keyed.length,
      added: 0,
    };
  }

  const outcome = {
    checked: true,
    artist: follow.name,
    newReleases: fresh.map((entry) => ({
      name: entry.release.name,
      year: entry.release.releaseYear,
      type: entry.release.albumType,
      spotifyId: entry.release.spotifyId,
    })),
    added: 0,
    failed: 0,
  };

  if (fresh.length === 0) {
    await touchChecked(userId, artistId);
    return outcome;
  }

  // A follow can be "notify me" rather than "add automatically". Recording the
  // releases as seen either way means a later switch to auto-add does not
  // suddenly ingest everything released while it was off.
  if (!follow.autoAdd) {
    await markSeen(userId, artistId, fresh.map((entry) => entry.key));
    await touchChecked(userId, artistId);
    outcome.autoAdd = false;
    return outcome;
  }

  for (const entry of fresh) {
    try {
      const { tracks } = await spotify.getAlbumTracks(entry.release.spotifyId);
      for (const track of tracks) {
        // Spotify lists every credited artist on a compilation, so a release
        // discovered through one artist can contain tracks they are not on.
        // Only the ones actually crediting the followed artist are wanted.
        const credited = (track.artists || []).some(
          (artist) => artist.spotifyId === follow.spotifyId
        );
        if (!credited) continue;

        const { trackId } = await resolveAndSave({
          spotifyId: track.spotifyId,
          isrc: track.isrc,
          title: track.title,
          durationMs: track.durationMs,
        });

        await query(
          `INSERT INTO library_tracks (user_id, track_id, added_via)
           VALUES ($1, $2, 'artist-follow')
           ON CONFLICT (user_id, track_id) DO NOTHING`,
          [userId, trackId]
        );

        if (follow.targetPlaylistId) {
          await appendToPlaylist(follow.targetPlaylistId, trackId);
        }
        outcome.added++;
      }
      await markSeen(userId, artistId, [entry.key]);
    } catch (err) {
      // A release that fails stays unseen, so the next check retries it rather
      // than skipping it permanently.
      console.error(
        `[follows] ${follow.name} / ${entry.release.name} failed:`,
        err.message
      );
      outcome.failed++;
    }
  }

  await touchChecked(userId, artistId);
  return outcome;
}

async function markSeen(userId, artistId, keys) {
  if (keys.length === 0) return;
  await query(
    `INSERT INTO artist_release_seen (user_id, artist_id, release_key)
     SELECT $1, $2, unnest($3::text[])
     ON CONFLICT (user_id, artist_id, release_key) DO NOTHING`,
    [userId, artistId, keys]
  );
}

async function touchChecked(userId, artistId) {
  await query(
    `UPDATE followed_artists SET last_checked_at = now()
      WHERE user_id = $1 AND artist_id = $2`,
    [userId, artistId]
  );
}

// Sweeps every follow that is due a check. Called on a timer from index.js.
//
// Serial rather than parallel, and rate limited by the provider clients
// underneath, because hammering Spotify with fifty concurrent requests is how an
// app gets its credentials throttled.
export async function checkDueFollows({ maxAgeHours = 12, limit = 25 } = {}) {
  if (!spotify.isEnabled()) return { checked: 0, skipped: 'spotify not configured' };

  const due = await many(
    `SELECT fa.user_id, fa.artist_id
       FROM followed_artists fa
       JOIN artists a ON a.id = fa.artist_id
      WHERE a.spotify_id IS NOT NULL
        AND (fa.last_checked_at IS NULL
             OR fa.last_checked_at < now() - ($1 || ' hours')::interval)
   ORDER BY fa.last_checked_at NULLS FIRST
      LIMIT $2`,
    [String(maxAgeHours), limit]
  );

  let added = 0;
  let checked = 0;
  for (const row of due) {
    try {
      const result = await checkFollowedArtist(row.user_id, row.artist_id);
      checked++;
      added += result.added || 0;
    } catch (err) {
      console.error('[follows] check failed:', err.message);
    }
  }
  return { checked, added, due: due.length };
}
