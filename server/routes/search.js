import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { many } from '../db/pool.js';
import { handler, str } from '../lib/api.js';
import { joinArtists } from '../lib/normalise.js';
import * as musicbrainz from '../providers/musicbrainz.js';
import * as spotify from '../providers/spotify.js';

export const searchRoutes = Router();
searchRoutes.use(requireUser);

// Searching for music to add.
//
// Two scopes, because they answer different questions:
//
//   /api/search/catalogue  - "is this already in my library?"
//   /api/search/providers  - "find me this song so I can add it"
//
// The provider search is rate limited per user: every call is an outbound
// request to Spotify or MusicBrainz, and a search-as-you-type frontend would
// otherwise burn through an API quota in a minute.

searchRoutes.get(
  '/catalogue',
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < 2) return res.json({ tracks: [] });

    const tracks = await many(
      `SELECT t.id,
              t.title,
              t.artist_credit  AS "artistCredit",
              t.album_credit   AS "albumCredit",
              t.duration_ms    AS "durationMs",
              t.metadata_state AS "metadataState",
              al.artwork_url   AS "artworkUrl",
              (lt.user_id IS NOT NULL) AS "inLibrary"
         FROM tracks t
    LEFT JOIN albums al ON al.id = t.album_id
    LEFT JOIN library_tracks lt ON lt.track_id = t.id AND lt.user_id = $1
        WHERE t.title ILIKE $2 OR t.artist_credit ILIKE $2 OR al.name ILIKE $2
     ORDER BY (lt.user_id IS NOT NULL) DESC, lower(t.title)
        LIMIT 30`,
      [req.user.id, `%${q}%`]
    );
    res.json({ tracks });
  })
);

searchRoutes.get(
  '/providers',
  // Generous enough for real typing, tight enough to protect the API quota.
  rateLimit({ windowMs: 60_000, max: 60, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < 2) {
      return res.json({ results: [], provider: null, providers: providerStatus() });
    }

    const type = ['track', 'album', 'artist'].includes(String(req.query.type))
      ? String(req.query.type)
      : 'track';

    // Spotify first, matching the resolver. Falling through on error rather than
    // failing means an expired credential or a rate limit degrades the search
    // instead of breaking it.
    if (spotify.isEnabled()) {
      try {
        const found = await spotify.searchAll(q, { types: type, limit: 20 });
        return res.json({
          provider: 'spotify',
          providers: providerStatus(),
          results: shape(found, type),
        });
      } catch (err) {
        console.error('[search] spotify failed:', err.message);
      }
    }

    if (musicbrainz.isEnabled()) {
      try {
        if (type === 'artist') {
          const artists = await musicbrainz.searchArtists(q, { limit: 20 });
          return res.json({
            provider: 'musicbrainz',
            providers: providerStatus(),
            results: artists.map((artist) => ({
              kind: 'artist',
              name: artist.name,
              mbid: artist.mbid,
              subtitle: [artist.disambiguation, artist.country]
                .filter(Boolean)
                .join(' - '),
            })),
          });
        }
        const tracks = await musicbrainz.searchTracks({ title: q, limit: 20 });
        return res.json({
          provider: 'musicbrainz',
          providers: providerStatus(),
          results: shape({ tracks }, 'track'),
        });
      } catch (err) {
        console.error('[search] musicbrainz failed:', err.message);
      }
    }

    // Neither provider is usable. Say so plainly rather than returning an empty
    // result that looks like "no such song".
    res.status(503).json({
      error:
        'No metadata provider is available. Configure Spotify credentials or a MusicBrainz contact in Settings.',
      providers: providerStatus(),
      results: [],
    });
  })
);

// A flat, provider-agnostic shape for the UI, so the search results list does
// not have to know which provider answered.
function shape(found, type) {
  if (type === 'album') {
    return (found.albums || []).map((album) => ({
      kind: 'album',
      name: album.name,
      spotifyId: album.spotifyId,
      mbid: album.mbid,
      artistCredit: joinArtists(album.artists),
      artworkUrl: album.artworkUrl,
      year: album.releaseYear,
      totalTracks: album.totalTracks,
      albumType: album.albumType,
    }));
  }
  if (type === 'artist') {
    return (found.artists || []).map((artist) => ({
      kind: 'artist',
      name: artist.name,
      spotifyId: artist.spotifyId,
      mbid: artist.mbid,
      imageUrl: artist.imageUrl,
      subtitle: (artist.genres || []).slice(0, 3).join(', '),
    }));
  }
  return (found.tracks || []).map((track) => ({
    kind: 'track',
    title: track.title,
    spotifyId: track.spotifyId,
    mbid: track.mbid,
    isrc: track.isrc,
    artistCredit: joinArtists(track.artists),
    albumName: track.album?.name || null,
    artworkUrl: track.album?.artworkUrl || null,
    durationMs: track.durationMs,
    year: track.album?.releaseYear || null,
    explicit: track.explicit,
  }));
}

function providerStatus() {
  return {
    spotify: spotify.isEnabled(),
    musicbrainz: musicbrainz.isEnabled(),
  };
}

// Expands an album into its tracks, so "add whole album" is one click. Returned
// unsaved: the user confirms, then POSTs them to /api/library/tracks.
searchRoutes.get(
  '/album',
  rateLimit({ windowMs: 60_000, max: 30, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const spotifyId = str(req.query.spotifyId, 'spotifyId', { max: 60 });
    const mbid = str(req.query.mbid, 'mbid', { max: 60 });

    if (spotifyId && spotify.isEnabled()) {
      const { album, tracks } = await spotify.getAlbumTracks(spotifyId);
      return res.json({ provider: 'spotify', album: albumShape(album), tracks: shape({ tracks }, 'track') });
    }
    if (mbid && musicbrainz.isEnabled()) {
      const { album, tracks } = await musicbrainz.getReleaseTracks(mbid);
      return res.json({
        provider: 'musicbrainz',
        album: albumShape(album),
        tracks: shape({ tracks }, 'track'),
      });
    }
    res.status(400).json({
      error: 'Supply a spotifyId or mbid for a provider that is configured.',
    });
  })
);

function albumShape(album) {
  if (!album) return null;
  return {
    name: album.name,
    spotifyId: album.spotifyId,
    mbid: album.mbid,
    artistCredit: joinArtists(album.artists),
    artworkUrl: album.artworkUrl,
    year: album.releaseYear,
    totalTracks: album.totalTracks,
  };
}
