import { Router } from 'express';
import { rateLimit, requireUser } from '../auth/middleware.js';
import { many } from '../db/pool.js';
import { badRequest, handler, notFound, str } from '../lib/api.js';
import { joinArtists } from '../lib/normalise.js';
import * as deezer from '../providers/deezer.js';
import * as itunes from '../providers/itunes.js';
import * as musicbrainz from '../providers/musicbrainz.js';
import * as youtube from '../providers/youtube.js';

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
// request, and a search-as-you-type frontend would otherwise burn through a
// quota in a minute.

// Same order as the resolver, and for the same reason - see PROVIDERS in
// services/resolver.js. Listed once here rather than as a hardcoded if-chain,
// so adding a provider does not mean editing three fallback ladders.
const PROVIDERS = [
  { name: 'deezer', label: 'Deezer', module: deezer },
  { name: 'itunes', label: 'iTunes', module: itunes },
  { name: 'musicbrainz', label: 'MusicBrainz', module: musicbrainz },
];

function providerStatus() {
  const status = {};
  for (const provider of PROVIDERS) status[provider.name] = provider.module.isEnabled();
  return status;
}

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
  // Generous enough for real typing, tight enough to protect the quota.
  rateLimit({ windowMs: 60_000, max: 60, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < 2) {
      return res.json({ results: [], provider: null, providers: providerStatus() });
    }

    // "all" is the default, because someone searching for a name usually wants
    // whichever of the three it turns out to be, and making them guess the
    // category first is a question the search can answer itself.
    const requested = String(req.query.type || 'all');
    const type = ['track', 'album', 'artist', 'all'].includes(requested) ? requested : 'all';

    if (type === 'all') {
      return res.json(await searchEverything(q));
    }

    // Tries each enabled provider in order and returns the first that answers
    // with something. Falling through on error rather than failing means an
    // expired credential or a rate limit degrades the search instead of
    // breaking it - and every failure along the way is reported, so a search
    // that finds nothing can be told apart from one where everything was down.
    const tried = [];
    for (const provider of PROVIDERS) {
      if (!provider.module.isEnabled()) continue;
      try {
        const found = await provider.module.searchAll(q, { types: type, limit: 20 });
        const results = shape(found, type);
        if (results.length > 0) {
          return res.json({
            provider: provider.name,
            providerLabel: provider.label,
            providers: providerStatus(),
            tried,
            results,
          });
        }
        tried.push({ provider: provider.name, ok: true, results: 0 });
      } catch (err) {
        console.error(`[search] ${provider.name} failed:`, err.message);
        tried.push({ provider: provider.name, ok: false, error: err.message });
      }
    }

    // Nothing found anywhere. Distinguish "no such song" from "nothing was
    // usable", because the fix is completely different.
    const anyEnabled = Object.values(providerStatus()).some(Boolean);
    if (!anyEnabled) {
      return res.status(503).json({
        error:
          'No metadata provider is available. Turn on Deezer or iTunes, or set a MusicBrainz contact, in Settings.',
        providers: providerStatus(),
        tried,
        results: [],
      });
    }
    const allFailed = tried.length > 0 && tried.every((entry) => !entry.ok);
    if (allFailed) {
      return res.status(502).json({
        error: `Every provider failed. ${tried.map((entry) => `${entry.provider}: ${entry.error}`).join(' | ')}`,
        providers: providerStatus(),
        tried,
        results: [],
      });
    }

    res.json({ provider: null, providers: providerStatus(), tried, results: [] });
  })
);

// YouTube, asked for by name.
//
// Deliberately its own endpoint rather than another rung on the ladder above.
// The three metadata providers answer in about a hundred milliseconds and return
// properly credited releases; this fetches and parses a megabyte of HTML, and
// returns video titles ranked by popularity. Making every search pay that cost
// for a case that comes up rarely would be the wrong trade - so it runs only
// when the user presses the button, which is also the honest way to present a
// source whose metadata should not be trusted.
searchRoutes.get(
  '/youtube',
  // Tighter than the provider ladder. Each of these is a page fetch rather than
  // an API call, and it is a button press rather than typing.
  rateLimit({ windowMs: 60_000, max: 20, key: (req) => `yt:${req.user?.id}` }),
  handler(async (req, res) => {
    const q = str(req.query.q, 'Search', { max: 200 });
    if (!q || q.length < 2) return res.json({ results: [] });

    if (!youtube.isEnabled()) {
      return res.status(503).json({
        error: 'YouTube search is turned off in Settings.',
        results: [],
      });
    }

    try {
      // YouTube Music first. It is a different index over the same catalogue
      // and it answers with structured fields - artist, album, song, each
      // tagged - instead of a video title to be guessed at. So results show
      // correct credits, and the resolver gets a real artist to match on.
      //
      // The video search stays as the fallback, because YouTube Music indexes
      // music and YouTube indexes everything: a track that only ever existed as
      // someone's upload is findable by the second and not the first.
      const music = await youtube.searchMusic(q, { limit: 20 });
      if (music.length > 0) {
        return res.json({
          provider: 'youtube',
          providerLabel: 'YouTube Music',
          structured: true,
          results: music,
        });
      }

      const results = await youtube.searchTracks(q, { limit: 20 });
      res.json({
        provider: 'youtube',
        providerLabel: 'YouTube',
        structured: false,
        results,
      });
    } catch (err) {
      // Reported rather than thrown. This is a secondary source reached by an
      // optional button, and a failure here must read as "that did not work"
      // rather than as the search being broken.
      console.error('[search] youtube failed:', err.message);
      res.status(err.status && err.status < 600 ? err.status : 502).json({
        error: err.message,
        results: [],
      });
    }
  })
);

// Songs, albums and artists in one pass.
//
// Each category runs the same provider ladder independently, because they fail
// independently: Deezer may know an artist that MusicBrainz does not, and
// falling back for one category should not drag the others onto a weaker
// source. Run together rather than in sequence - three round trips one after
// another would make the default search three times slower than the old one.
async function searchEverything(q) {
  const categories = ['track', 'album', 'artist'];
  const settled = await Promise.all(categories.map((type) => searchOne(q, type)));

  const groups = {};
  const answered = {};
  categories.forEach((type, index) => {
    groups[type] = settled[index].results;
    if (settled[index].provider) answered[type] = settled[index].provider;
  });

  return {
    type: 'all',
    providers: providerStatus(),
    answeredBy: answered,
    groups,
    // Kept flat as well so anything counting results does not need to know the
    // response gained a shape.
    results: [...groups.track, ...groups.album, ...groups.artist],
  };
}

// One category, down the provider ladder, never throwing. A category that finds
// nothing is an ordinary outcome and must not take the other two with it.
async function searchOne(q, type) {
  for (const provider of PROVIDERS) {
    if (!provider.module.isEnabled()) continue;
    try {
      const found = await provider.module.searchAll(q, { types: type, limit: 12 });
      const results = shape(found, type);
      if (results.length > 0) return { provider: provider.name, results };
    } catch (err) {
      console.error(`[search] ${provider.name} ${type} failed:`, err.message);
    }
  }
  return { provider: null, results: [] };
}

// An artist's page: who they are, what they released, and what to play first.
searchRoutes.get(
  '/artist',
  rateLimit({ windowMs: 60_000, max: 30, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    const deezerId = str(req.query.deezerId, 'deezerId', { max: 60 });
    if (!deezerId) {
      throw badRequest('An artist page needs a Deezer id.');
    }
    if (!deezer.isEnabled()) {
      return res.status(503).json({ error: 'Deezer is turned off in Settings.' });
    }

    // Three independent calls, none of which should lose the page. An artist
    // with no albums on Deezer still has a name and top tracks worth showing.
    const [artist, albums, topTracks] = await Promise.all([
      deezer.getArtist(deezerId).catch(() => null),
      deezer.getArtistAlbums(deezerId, { limit: 50 }).catch(() => []),
      deezer.getArtistTopTracks(deezerId, { limit: 15 }).catch(() => []),
    ]);

    if (!artist) throw notFound('That artist could not be found.');

    res.json({
      artist: {
        kind: 'artist',
        name: artist.name,
        deezerId: artist.deezerId,
        imageUrl: artist.imageUrl,
        subtitle: (artist.genres || []).slice(0, 3).join(', '),
      },
      // Newest first, which is the order a discography is read in.
      albums: shape({ albums }, 'album').sort((a, b) => (b.year || 0) - (a.year || 0)),
      topTracks: shape({ tracks: topTracks }, 'track'),
    });
  })
);

// A flat, provider-agnostic shape for the UI, so the results list does not have
// to know which provider answered.
function shape(found, type) {
  if (type === 'album') {
    return (found.albums || []).map((album) => ({
      kind: 'album',
      name: album.name,
      deezerId: album.deezerId,
      itunesId: album.itunesId,
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
      deezerId: artist.deezerId,
      itunesId: artist.itunesId,
      mbid: artist.mbid,
      imageUrl: artist.imageUrl,
      subtitle:
        (artist.genres || []).slice(0, 3).join(', ') ||
        [artist.disambiguation, artist.country].filter(Boolean).join(' - '),
    }));
  }
  return (found.tracks || []).map((track) => ({
    kind: 'track',
    title: track.title,
    deezerId: track.deezerId,
    itunesId: track.itunesId,
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

// Expands an album into its tracks, so "add whole album" is one click. Returned
// unsaved: the user confirms, then POSTs them to /api/library/tracks.
searchRoutes.get(
  '/album',
  rateLimit({ windowMs: 60_000, max: 30, key: (req) => `user:${req.user?.id}` }),
  handler(async (req, res) => {
    // Whichever id the search result carried decides which provider to ask.
    const ids = {
      deezer: str(req.query.deezerId, 'deezerId', { max: 60 }),
      itunes: str(req.query.itunesId, 'itunesId', { max: 60 }),
      musicbrainz: str(req.query.mbid, 'mbid', { max: 60 }),
    };

    for (const provider of PROVIDERS) {
      const id = ids[provider.name];
      if (!id || !provider.module.isEnabled() || !provider.module.getAlbumTracks) continue;

      const method =
        provider.name === 'musicbrainz'
          ? provider.module.getReleaseTracks
          : provider.module.getAlbumTracks;

      const { album, tracks } = await method(id);
      return res.json({
        provider: provider.name,
        album: albumShape(album),
        tracks: shape({ tracks }, 'track'),
      });
    }

    res.status(400).json({
      error: 'Supply an id for a provider that is enabled.',
      providers: providerStatus(),
    });
  })
);

function albumShape(album) {
  if (!album) return null;
  return {
    name: album.name,
    deezerId: album.deezerId,
    itunesId: album.itunesId,
    mbid: album.mbid,
    artistCredit: joinArtists(album.artists),
    artworkUrl: album.artworkUrl,
    year: album.releaseYear,
    totalTracks: album.totalTracks,
  };
}
