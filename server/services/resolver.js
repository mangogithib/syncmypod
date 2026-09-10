import { transaction } from '../db/pool.js';
import { joinArtists, matchKey, scoreCandidate, stripDecorations } from '../lib/normalise.js';
import * as musicbrainz from '../providers/musicbrainz.js';
import * as spotify from '../providers/spotify.js';

// Metadata resolution.
//
// The rule from the concept: never trust a download source's own title or
// description. Whatever a track claims to be, it is re-resolved against a real
// catalogue before anything is written to the iPod. Spotify first, MusicBrainz
// as fallback.
//
// Resolution has three tiers, strongest first:
//
//   1. ISRC lookup. An exact identifier for a specific recording. No scoring
//      needed - a hit is definitionally the right track.
//   2. Structured search (title + artist + album) with candidate scoring, so a
//      near-miss is rejected rather than silently accepted.
//   3. Loose search on the cleaned-up title alone, for the case where the
//      source metadata was so poor that the "artist" was part of the title.
//
// Anything that clears ACCEPT_SCORE is stored as `resolved`. Anything below it
// is stored as `unresolved` with the best candidate remembered, so the UI can
// offer it as a suggestion for a human to confirm rather than guessing.

// Tuned against the weighting in scoreCandidate: a correct title plus a correct
// artist scores ~0.8, a right title with a wrong artist scores ~0.5. Sitting the
// bar at 0.62 accepts the former and rejects the latter.
const ACCEPT_SCORE = 0.62;
// Below this a candidate is not even worth showing as a suggestion.
const SUGGEST_SCORE = 0.35;

// Resolves one track description into a canonical record.
//
// `input` is whatever is known: { title, artist, album, isrc, durationMs,
// spotifyId, mbid }. Nothing is required except something to search on.
export async function resolveTrack(input, { preferProvider } = {}) {
  const order = providerOrder(preferProvider);
  const attempts = [];

  // --- Direct id lookups ---------------------------------------------------
  // If the caller already knows a provider id (a Spotify import does), there is
  // nothing to search for.
  if (input.spotifyId && spotify.isEnabled()) {
    const track = await safely(() => spotify.getTrack(input.spotifyId), attempts, 'spotify:id');
    if (track) return accepted(track, 'spotify', 1, attempts);
  }
  if (input.mbid && musicbrainz.isEnabled()) {
    const track = await safely(() => musicbrainz.getRecording(input.mbid), attempts, 'musicbrainz:id');
    if (track) return accepted(track, 'musicbrainz', 1, attempts);
  }

  // --- Tier 1: ISRC --------------------------------------------------------
  if (input.isrc) {
    for (const provider of order) {
      if (!provider.module.isEnabled()) continue;
      const track = await safely(
        () => provider.module.findByIsrc(input.isrc),
        attempts,
        `${provider.name}:isrc`
      );
      if (track) return accepted(track, provider.name, 1, attempts);
    }
  }

  if (!input.title) {
    return unresolved(attempts, 'Nothing to search on: no title, ISRC or provider id.');
  }

  // --- Tier 2: structured search ------------------------------------------
  const cleanTitle = stripDecorations(input.title);
  let best = null;

  for (const provider of order) {
    if (!provider.module.isEnabled()) continue;

    const candidates = await safely(
      () =>
        provider.module.searchTracks({
          title: cleanTitle,
          artist: input.artist,
          album: input.album,
          limit: 10,
        }),
      attempts,
      `${provider.name}:search`
    );

    const scored = scoreAll(candidates || [], { ...input, title: cleanTitle });
    if (scored && (!best || scored.score > best.score)) {
      best = { ...scored, provider: provider.name };
    }
    // A confident hit from the preferred provider ends the search: querying
    // MusicBrainz as well would cost a second per track for no gain.
    if (best && best.score >= ACCEPT_SCORE) {
      return accepted(best.candidate, best.provider, best.score, attempts);
    }
  }

  // --- Tier 3: loose title-only search ------------------------------------
  // For the "video title as metadata" case, where the artist field was junk or
  // the artist name was embedded in the title.
  if (!best || best.score < ACCEPT_SCORE) {
    const loose = looseQuery(input);
    if (loose && loose !== cleanTitle) {
      for (const provider of order) {
        if (!provider.module.isEnabled()) continue;
        const candidates = await safely(
          () => provider.module.searchTracks({ title: loose, limit: 10 }),
          attempts,
          `${provider.name}:loose`
        );
        const scored = scoreAll(candidates || [], { ...input, title: loose });
        if (scored && (!best || scored.score > best.score)) {
          best = { ...scored, provider: provider.name };
        }
        if (best && best.score >= ACCEPT_SCORE) {
          return accepted(best.candidate, best.provider, best.score, attempts);
        }
      }
    }
  }

  if (best && best.score >= SUGGEST_SCORE) {
    return {
      state: 'unresolved',
      score: best.score,
      // Kept so the UI can say "did you mean X?" rather than just failing.
      suggestion: best.candidate,
      suggestionProvider: best.provider,
      attempts,
      reason: `Best match scored ${best.score.toFixed(2)}, below the ${ACCEPT_SCORE} threshold.`,
    };
  }

  return unresolved(attempts, 'No provider returned a plausible match.');
}

function providerOrder(preferProvider) {
  const spotifyEntry = { name: 'spotify', module: spotify };
  const musicbrainzEntry = { name: 'musicbrainz', module: musicbrainz };
  // Spotify first by default: its catalogue separates featured artists into
  // distinct, ordered fields and has clean artwork and track numbers, which is
  // exactly what raw download-source metadata loses.
  return preferProvider === 'musicbrainz'
    ? [musicbrainzEntry, spotifyEntry]
    : [spotifyEntry, musicbrainzEntry];
}

function scoreAll(candidates, input) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const similarityScore = scoreCandidate(
      {
        title: input.title,
        artist: input.artist,
        album: input.album,
        durationMs: input.durationMs,
      },
      {
        title: candidate.title,
        artistCredit: joinArtists(candidate.artists),
        albumName: candidate.album?.name,
        durationMs: candidate.durationMs,
      }
    );

    // A provider may report that a candidate, while a textual match, is a poor
    // representation of the recording - a bootleg or a live take rather than
    // the studio version. Those are indistinguishable on title and artist
    // alone, so without this the first one returned simply wins.
    const score = Math.max(0, similarityScore - (candidate.qualityPenalty || 0));

    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

// Turns "Artist - Title (Official Video)" into something searchable. Download
// sources overwhelmingly use this shape, and the hyphen split is what recovers
// an artist that was never in an artist field.
function looseQuery(input) {
  const cleaned = stripDecorations(input.title);
  const dash = cleaned.split(/\s+[-–—|]\s+/);
  if (dash.length >= 2) {
    // The longer half is more likely the title; the shorter is usually the
    // artist. Not always right, but the score gate catches it when it is wrong.
    return dash.slice(1).join(' ').trim() || cleaned;
  }
  return cleaned;
}

async function safely(fn, attempts, label) {
  try {
    const result = await fn();
    attempts.push({ step: label, ok: true, found: Boolean(result) });
    return result;
  } catch (err) {
    // One provider being down, rate limited or unconfigured must not fail the
    // whole resolution - that is the entire point of having a fallback.
    attempts.push({ step: label, ok: false, error: err.message });
    return null;
  }
}

function accepted(candidate, provider, score, attempts) {
  return { state: 'resolved', track: candidate, provider, score, attempts };
}

function unresolved(attempts, reason) {
  return { state: 'unresolved', attempts, reason, score: 0 };
}

// ---------------------------------------------------------------------------
// Persisting a resolved record into the catalogue
// ---------------------------------------------------------------------------

// Upserts an artist and returns its id. ON CONFLICT on match_key is what makes
// this safe to call concurrently: two imports resolving the same featured artist
// at the same time converge on one row instead of raising a unique violation.
async function upsertArtist(client, artist) {
  const key = matchKey({
    spotifyId: artist.spotifyId,
    mbid: artist.mbid,
    name: artist.name,
  });

  const { rows } = await client.query(
    `INSERT INTO artists (match_key, name, sort_name, spotify_id, mbid, image_url, genres)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (match_key) DO UPDATE
        SET name       = EXCLUDED.name,
            -- COALESCE the other way round for ids: once a row has learned a
            -- provider id, a later record that lacks it must not erase it.
            spotify_id = COALESCE(artists.spotify_id, EXCLUDED.spotify_id),
            mbid       = COALESCE(artists.mbid, EXCLUDED.mbid),
            image_url  = COALESCE(EXCLUDED.image_url, artists.image_url),
            genres     = COALESCE(EXCLUDED.genres, artists.genres),
            sort_name  = COALESCE(EXCLUDED.sort_name, artists.sort_name),
            updated_at = now()
     RETURNING id`,
    [
      key,
      artist.name,
      artist.sortName || null,
      artist.spotifyId || null,
      artist.mbid || null,
      artist.imageUrl || null,
      artist.genres || null,
    ]
  );
  return rows[0].id;
}

async function upsertAlbum(client, album) {
  if (!album?.name) return null;

  const albumArtist = album.artists?.[0];
  const albumArtistId = albumArtist ? await upsertArtist(client, albumArtist) : null;

  const key = matchKey({
    spotifyId: album.spotifyId,
    mbid: album.mbid,
    name: album.name,
    // Two different albums genuinely share a name ("Greatest Hits"), so the
    // name-only fallback key is qualified by the album artist.
    extra: albumArtist?.name,
  });

  const { rows } = await client.query(
    `INSERT INTO albums (match_key, name, album_artist_id, spotify_id, mbid,
                         release_date, release_year, artwork_url, total_tracks, album_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (match_key) DO UPDATE
        SET name            = EXCLUDED.name,
            album_artist_id = COALESCE(EXCLUDED.album_artist_id, albums.album_artist_id),
            spotify_id      = COALESCE(albums.spotify_id, EXCLUDED.spotify_id),
            mbid            = COALESCE(albums.mbid, EXCLUDED.mbid),
            release_date    = COALESCE(EXCLUDED.release_date, albums.release_date),
            release_year    = COALESCE(EXCLUDED.release_year, albums.release_year),
            artwork_url     = COALESCE(EXCLUDED.artwork_url, albums.artwork_url),
            total_tracks    = COALESCE(EXCLUDED.total_tracks, albums.total_tracks),
            album_type      = COALESCE(EXCLUDED.album_type, albums.album_type),
            updated_at      = now()
     RETURNING id`,
    [
      key,
      album.name,
      albumArtistId,
      album.spotifyId || null,
      album.mbid || null,
      album.releaseDate || null,
      album.releaseYear || null,
      album.artworkUrl || null,
      album.totalTracks || null,
      album.albumType || null,
    ]
  );
  return rows[0].id;
}

// Writes a resolved track and everything it references. Runs in one transaction
// so a track never exists without its artists.
export async function saveResolvedTrack(resolved, { client } = {}) {
  const run = async (tx) => {
    const track = resolved.track;
    const albumId = await upsertAlbum(tx, track.album);

    const artistIds = [];
    for (const artist of track.artists || []) {
      artistIds.push({ id: await upsertArtist(tx, artist), ...artist });
    }

    const key = matchKey({
      spotifyId: track.spotifyId,
      mbid: track.mbid,
      name: track.title,
      extra: [track.artists?.[0]?.name, track.album?.name].filter(Boolean).join(' '),
    });

    const artistCredit = joinArtists(track.artists);

    const { rows } = await tx.query(
      `INSERT INTO tracks (match_key, title, album_id, track_no, disc_no, duration_ms,
                           isrc, spotify_id, mbid, explicit, artist_credit, album_credit,
                           metadata_source, metadata_state, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'resolved', now())
       ON CONFLICT (match_key) DO UPDATE
          SET title        = EXCLUDED.title,
              album_id     = COALESCE(EXCLUDED.album_id, tracks.album_id),
              track_no     = COALESCE(EXCLUDED.track_no, tracks.track_no),
              disc_no      = COALESCE(EXCLUDED.disc_no, tracks.disc_no),
              duration_ms  = COALESCE(EXCLUDED.duration_ms, tracks.duration_ms),
              isrc         = COALESCE(tracks.isrc, EXCLUDED.isrc),
              spotify_id   = COALESCE(tracks.spotify_id, EXCLUDED.spotify_id),
              mbid         = COALESCE(tracks.mbid, EXCLUDED.mbid),
              explicit     = COALESCE(EXCLUDED.explicit, tracks.explicit),
              artist_credit = EXCLUDED.artist_credit,
              album_credit  = EXCLUDED.album_credit,
              metadata_source = EXCLUDED.metadata_source,
              -- A track a human has corrected stays 'manual'. Automated
              -- resolution must never silently overwrite a manual fix.
              metadata_state  = CASE WHEN tracks.metadata_state = 'manual'
                                     THEN 'manual' ELSE 'resolved' END,
              resolved_at  = now(),
              updated_at   = now()
       RETURNING id, metadata_state`,
      [
        key,
        track.title,
        albumId,
        track.trackNo || null,
        track.discNo || null,
        track.durationMs || null,
        track.isrc || null,
        track.spotifyId || null,
        track.mbid || null,
        track.explicit,
        artistCredit,
        track.album?.name || null,
        resolved.provider,
      ]
    );
    const trackId = rows[0].id;

    // Replace rather than merge the artist list: if resolution now says two
    // artists where it previously said three, the extra one is wrong and must go.
    await tx.query('DELETE FROM track_artists WHERE track_id = $1', [trackId]);
    for (const artist of artistIds) {
      await tx.query(
        `INSERT INTO track_artists (track_id, artist_id, position, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (track_id, artist_id, role) DO NOTHING`,
        [trackId, artist.id, artist.position ?? 0, artist.role || 'primary']
      );
    }

    return trackId;
  };

  // Accepts an existing client so a bulk import can wrap many tracks in one
  // transaction instead of paying per-track transaction overhead.
  return client ? run(client) : transaction(run);
}

// Stores a track that could not be resolved, so it is visible and fixable in the
// UI rather than silently dropped. The local app skips these: writing a file
// tagged with an unverified video title is exactly what this design avoids.
export async function saveUnresolvedTrack(input, resolution, { client } = {}) {
  const run = async (tx) => {
    const key = matchKey({
      name: input.title,
      extra: [input.artist, input.album].filter(Boolean).join(' '),
    });

    const { rows } = await tx.query(
      `INSERT INTO tracks (match_key, title, artist_credit, album_credit, duration_ms,
                           isrc, metadata_state, metadata_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'unresolved', $7)
       ON CONFLICT (match_key) DO UPDATE
          SET metadata_state = CASE WHEN tracks.metadata_state IN ('resolved', 'manual')
                                    THEN tracks.metadata_state ELSE 'unresolved' END,
              updated_at = now()
       RETURNING id`,
      [
        key,
        input.title || 'Unknown track',
        input.artist || '',
        input.album || null,
        input.durationMs || null,
        input.isrc || null,
        resolution?.suggestionProvider || null,
      ]
    );
    return rows[0].id;
  };
  return client ? run(client) : transaction(run);
}

// Convenience for the common path: resolve, then persist whichever way it went.
export async function resolveAndSave(input, options = {}) {
  const resolution = await resolveTrack(input, options);
  if (resolution.state === 'resolved') {
    const trackId = await saveResolvedTrack(resolution, options);
    return { trackId, resolution };
  }
  const trackId = await saveUnresolvedTrack(input, resolution, options);
  return { trackId, resolution };
}
