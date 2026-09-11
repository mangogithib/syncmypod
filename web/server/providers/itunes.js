import { cached, createRateLimiter, fetchJson, ProviderError } from '../lib/http.js';
import { yearFromDate } from '../lib/normalise.js';
import { providerToggle } from '../services/app-settings.js';

// iTunes / Apple Music Search API client.
//
// No credentials required. In testing it had the best coverage of film and
// regional catalogue of the credential-free options, and it returns track
// numbers, disc numbers, release year and genre in the search response itself -
// no second request needed.
//
// THE ONE IMPORTANT LIMITATION: it gives a single `artistName` string, such as
// "Pritam, Arijit Singh & Amitabh Bhattacharya". It does NOT give a structured
// list.
//
// This provider deliberately does NOT split that string into separate artists.
// It is tempting - most of the time splitting on ", " and " & " works - but the
// failure case is silent and permanent: "Earth, Wind & Fire" becomes three
// artists, "Simon & Garfunkel" becomes two, and the catalogue is then wrong in a
// way nobody notices until an iPod shows three artists that never existed.
//
// So the credit string is kept whole and treated as one artist. That is still
// correct for the iPod tag, which wants exactly that string. Where genuine
// structure matters, Deezer's /track endpoint provides it properly and is tried
// first - see the provider order in services/resolver.js.

const API = 'https://itunes.apple.com';

// Apple does not publish a hard figure but describes roughly 20 requests per
// minute for the Search API, and returns 403 to clients that exceed it. 3.1s
// between calls keeps to that. It is slow, which is another reason this sits
// behind Deezer rather than in front of it.
const limiter = createRateLimiter(3100);

export function isEnabled() {
  return providerToggle('itunes');
}

async function get(path, params = {}) {
  if (!isEnabled()) {
    throw new ProviderError('iTunes is turned off in Settings.', {
      provider: 'itunes',
      status: 503,
    });
  }

  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return limiter(() =>
    fetchJson(url.toString(), {
      provider: 'itunes',
      timeoutMs: 15_000,
      // The endpoint sometimes answers with a JavaScript content type; the
      // body is still JSON, and fetchJson parses on content rather than header.
      headers: { Accept: 'application/json' },
    })
  );
}

// ---------------------------------------------------------------------------
// Shape conversion
// ---------------------------------------------------------------------------

// Artwork URLs embed their own dimensions, so a larger version is a string
// substitution rather than another request. 600px is ample for a device whose
// screen is 320x240.
function upscaleArtwork(url) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/600x600bb.$1');
}

function toArtist(result) {
  const name = result.artistName;
  if (!name) return null;
  return {
    provider: 'itunes',
    itunesId: result.artistId ? String(result.artistId) : null,
    name,
    imageUrl: null, // The Search API does not return artist images.
    position: 0,
    role: 'primary',
  };
}

function toAlbum(result) {
  if (!result.collectionName) return null;
  return {
    provider: 'itunes',
    itunesId: result.collectionId ? String(result.collectionId) : null,
    name: result.collectionName,
    releaseDate: result.releaseDate || null,
    releaseYear: yearFromDate(result.releaseDate),
    artworkUrl: upscaleArtwork(result.artworkUrl100 || result.artworkUrl60),
    totalTracks: result.trackCount ?? null,
    albumType: result.collectionType ? String(result.collectionType).toLowerCase() : null,
    artists: [
      {
        provider: 'itunes',
        itunesId: result.collectionArtistId
          ? String(result.collectionArtistId)
          : result.artistId
            ? String(result.artistId)
            : null,
        name: result.collectionArtistName || result.artistName,
        position: 0,
        role: 'primary',
      },
    ].filter((artist) => artist.name),
  };
}

function toTrack(result) {
  if (!result || result.wrapperType !== 'track' || !result.trackId) return null;

  const primary = toArtist(result);

  return {
    provider: 'itunes',
    itunesId: String(result.trackId),
    // The Search API does not expose ISRCs.
    isrc: null,
    title: result.trackName,
    durationMs: result.trackTimeMillis ?? null,
    trackNo: result.trackNumber ?? null,
    discNo: result.discNumber ?? null,
    explicit:
      result.trackExplicitness === 'explicit'
        ? true
        : result.trackExplicitness === 'cleaned' ||
            result.trackExplicitness === 'notExplicit'
          ? false
          : null,
    genre: result.primaryGenreName || null,
    // One entry, holding the whole credit string. See the note at the top of
    // this file for why it is not split.
    artists: [primary].filter(Boolean),
    album: toAlbum(result),
    externalUrl: result.trackViewUrl || null,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

// No ISRC support, so the resolver's strongest tier simply skips this provider.
// Declared explicitly rather than left undefined so the resolver does not have
// to special-case it.
export async function findByIsrc() {
  return null;
}

export async function searchTracks({ title, artist, album, limit = 10 }) {
  // A single free-text term, which is all this endpoint accepts. The album is
  // included only when there is no artist, since adding both tends to
  // over-constrain and return nothing.
  const term = [artist, title, !artist ? album : null].filter(Boolean).join(' ').trim();
  if (!term) return [];

  return cached(`itunes:search:${limit}:${term}`, 'itunes', async () => {
    const body = await get('/search', {
      media: 'music',
      entity: 'song',
      limit,
      term,
    });
    return (body?.results || []).map(toTrack).filter(Boolean);
  });
}

export async function searchAll(q, { types = 'track', limit = 20 } = {}) {
  const entity = types === 'album' ? 'album' : types === 'artist' ? 'musicArtist' : 'song';
  const body = await get('/search', { media: 'music', entity, limit, term: q });
  const results = body?.results || [];

  if (types === 'album') {
    return {
      tracks: [],
      albums: results
        .filter((result) => result.collectionName)
        .map((result) => toAlbum(result))
        .filter(Boolean),
      artists: [],
    };
  }
  if (types === 'artist') {
    return {
      tracks: [],
      albums: [],
      artists: results
        .filter((result) => result.artistName)
        .map((result) => ({
          provider: 'itunes',
          itunesId: result.artistId ? String(result.artistId) : null,
          name: result.artistName,
          imageUrl: null,
          genres: result.primaryGenreName ? [result.primaryGenreName] : null,
        })),
      };
  }
  return { tracks: results.map(toTrack).filter(Boolean), albums: [], artists: [] };
}

export async function getAlbumTracks(itunesId) {
  return cached(`itunes:album:${itunesId}`, 'itunes', async () => {
    // The lookup endpoint returns the collection first, then its tracks.
    const body = await get('/lookup', {
      id: itunesId,
      entity: 'song',
      limit: 200,
    });
    const results = body?.results || [];

    const collection = results.find((result) => result.wrapperType === 'collection');
    const tracks = results.map(toTrack).filter(Boolean);

    const album = collection
      ? toAlbum({
          collectionName: collection.collectionName,
          collectionId: collection.collectionId,
          collectionArtistName: collection.artistName,
          collectionArtistId: collection.artistId,
          releaseDate: collection.releaseDate,
          artworkUrl100: collection.artworkUrl100,
          trackCount: collection.trackCount,
          collectionType: collection.collectionType,
        })
      : tracks[0]?.album || null;

    // Every track carries the album from its own row; overwrite with the
    // collection record so all of them agree on one album identity.
    return { album, tracks: album ? tracks.map((t) => ({ ...t, album })) : tracks };
  });
}

export async function getArtistAlbums(itunesId, { limit = 50 } = {}) {
  const body = await get('/lookup', { id: itunesId, entity: 'album', limit });
  return (body?.results || [])
    .filter((result) => result.wrapperType === 'collection')
    .map((collection) =>
      toAlbum({
        collectionName: collection.collectionName,
        collectionId: collection.collectionId,
        collectionArtistName: collection.artistName,
        collectionArtistId: collection.artistId,
        releaseDate: collection.releaseDate,
        artworkUrl100: collection.artworkUrl100,
        trackCount: collection.trackCount,
        collectionType: collection.collectionType,
      })
    )
    .filter(Boolean);
}
