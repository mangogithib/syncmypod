import { cached, createRateLimiter, fetchJson, ProviderError } from '../lib/http.js';
import { yearFromDate } from '../lib/normalise.js';
import { providerToggle } from '../services/app-settings.js';

// Deezer client.
//
// Needs no credentials at all, which is its main practical advantage: it works
// on a fresh instance with nothing configured.
//
// Its shape has one wrinkle that drives the design here. The /search endpoint is
// cheap and returns only the PRIMARY artist - so "Kesariya" comes back credited
// to Pritam alone, losing Arijit Singh. The /track/{id} endpoint returns the
// full ordered `contributors` list plus the ISRC, track position and disc
// number, but costs a request per track.
//
// So search returns light records good enough to rank, and `hydrate()` fills in
// the rest for the one candidate that actually wins. The resolver calls it
// before saving, which keeps a 300-track import to roughly one extra request per
// track rather than one per candidate considered.

const API = 'https://api.deezer.com';

// Deezer's published guidance is about 50 requests per 5 seconds. 150ms between
// calls stays comfortably inside that with room for burstiness.
const limiter = createRateLimiter(150);

export function isEnabled() {
  return providerToggle('deezer');
}

async function get(path, params = {}) {
  if (!isEnabled()) {
    throw new ProviderError('Deezer is turned off in Settings.', {
      provider: 'deezer',
      status: 503,
    });
  }

  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const body = await limiter(() =>
    fetchJson(url.toString(), { provider: 'deezer', timeoutMs: 15_000 })
  );

  // Deezer signals failure in a 200 response body rather than with a status
  // code, so an unchecked call would silently treat an error as empty data.
  if (body && body.error && Object.keys(body.error).length > 0) {
    const { message, code, type } = body.error;
    throw new ProviderError(`deezer: ${message || type || 'unknown error'}`, {
      provider: 'deezer',
      status: code === 4 ? 429 : 502,
      // Code 4 is their rate-limit signal; everything else is worth retrying.
      retryable: code === 4,
    });
  }
  return body;
}

// ---------------------------------------------------------------------------
// Shape conversion
// ---------------------------------------------------------------------------

function artwork(source) {
  // Widest first. The local app downscales when writing the tag, and
  // downscaling from a good source beats upscaling a thumbnail.
  return (
    source?.cover_xl || source?.cover_big || source?.cover_medium || source?.cover || null
  );
}

function artistArtwork(source) {
  return (
    source?.picture_xl || source?.picture_big || source?.picture_medium || source?.picture || null
  );
}

function toArtist(artist, index = 0) {
  if (!artist?.name) return null;
  return {
    provider: 'deezer',
    deezerId: artist.id ? String(artist.id) : null,
    name: artist.name,
    imageUrl: artistArtwork(artist),
    position: index,
    role: index === 0 ? 'primary' : 'featured',
  };
}

function toAlbum(album, albumArtist) {
  if (!album?.title) return null;
  return {
    provider: 'deezer',
    deezerId: album.id ? String(album.id) : null,
    name: album.title,
    releaseDate: album.release_date || null,
    releaseYear: yearFromDate(album.release_date),
    artworkUrl: artwork(album),
    totalTracks: album.nb_tracks ?? null,
    albumType: album.record_type || null,
    artists: [albumArtist || toArtist(album.artist)].filter(Boolean),
  };
}

// A /search result: no ISRC, no track number, primary artist only.
function toLightTrack(track) {
  if (!track?.id) return null;
  const primary = toArtist(track.artist);
  return {
    provider: 'deezer',
    deezerId: String(track.id),
    isrc: null,
    title: track.title_short || track.title,
    // Deezer reports duration in whole seconds; everything internal is ms.
    durationMs: track.duration ? track.duration * 1000 : null,
    trackNo: null,
    discNo: null,
    explicit:
      typeof track.explicit_lyrics === 'boolean' ? track.explicit_lyrics : null,
    artists: [primary].filter(Boolean),
    album: toAlbum(track.album, primary),
    externalUrl: track.link || null,
    // Tells the resolver there is more to fetch before this is worth saving.
    needsHydration: true,
  };
}

// A /track/{id} result: the full record.
function toFullTrack(track) {
  if (!track?.id) return null;

  // `contributors` is the ordered credit list. This is the field that makes
  // Deezer worth preferring over a provider that only hands back a single
  // joined string - the ordering is what tells a primary artist from a feature.
  const contributors = Array.isArray(track.contributors) ? track.contributors : [];
  const artists =
    contributors.length > 0
      ? contributors.map((artist, index) => toArtist(artist, index)).filter(Boolean)
      : [toArtist(track.artist)].filter(Boolean);

  return {
    provider: 'deezer',
    deezerId: String(track.id),
    isrc: track.isrc || null,
    title: track.title_short || track.title,
    durationMs: track.duration ? track.duration * 1000 : null,
    trackNo: track.track_position ?? null,
    discNo: track.disk_number ?? null,
    explicit:
      typeof track.explicit_lyrics === 'boolean' ? track.explicit_lyrics : null,
    artists,
    album: toAlbum(track.album, artists[0]),
    externalUrl: track.link || null,
    needsHydration: false,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function findByIsrc(isrc) {
  const clean = String(isrc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 12) return null;

  return cached(`deezer:isrc:${clean}`, 'deezer', async () => {
    try {
      // A dedicated endpoint, so an ISRC hit costs one request and needs no
      // scoring - it identifies the recording outright.
      const body = await get(`/track/isrc:${clean}`);
      return toFullTrack(body);
    } catch (err) {
      // "not found" arrives as an error body, not a 404, and is a normal answer.
      if (/not found|no data/i.test(err.message)) return null;
      throw err;
    }
  });
}

export async function searchTracks({ title, artist, limit = 10 }) {
  // Deezer supports a field-qualified query syntax, which is far more precise
  // than concatenating terms into free text.
  //
  // The album is deliberately NOT one of the qualifiers, even when the caller
  // supplied one. Album titles diverge wildly between services - a film song
  // iTunes files under the soundtrack, Deezer often files under the song's own
  // name - so `album:` turns a good match into zero results rather than
  // narrowing it. Searching for Kesariya with album:"Brahmastra" returns
  // nothing at all, because Deezer calls that album "Kesariya".
  //
  // The album is still passed to the scorer, where a match counts in a
  // candidate's favour and a mismatch simply does not. A weak signal is useful
  // for ranking and harmful as a filter.
  const parts = [];
  if (artist) parts.push(`artist:"${String(artist).replace(/"/g, '')}"`);
  if (title) parts.push(`track:"${String(title).replace(/"/g, '')}"`);
  const q = parts.length > 0 ? parts.join(' ') : String(title || '');
  if (!q.trim()) return [];

  return cached(`deezer:search:v2:${limit}:${q}`, 'deezer', async () => {
    let body = await get('/search', { q, limit });
    let items = body?.data || [];

    // Even artist and track together can miss on a spelling or transliteration
    // difference, so free text is the last resort rather than a failure.
    if (items.length === 0 && parts.length > 1) {
      body = await get('/search', {
        q: [artist, title].filter(Boolean).join(' '),
        limit,
      });
      items = body?.data || [];
    }

    return items.map(toLightTrack).filter(Boolean);
  });
}

// Fills in ISRC, track number, disc number and the full artist credit for a
// track that came from a search. Called by the resolver on the winning
// candidate only.
export async function hydrate(track) {
  if (!track?.deezerId || !track.needsHydration) return track;
  return cached(`deezer:track:${track.deezerId}`, 'deezer', async () => {
    const body = await get(`/track/${encodeURIComponent(track.deezerId)}`);
    return toFullTrack(body) || track;
  });
}

export async function searchAll(q, { types = 'track', limit = 20 } = {}) {
  if (types === 'album') {
    const body = await get('/search/album', { q, limit });
    return {
      tracks: [],
      albums: (body?.data || []).map((album) => toAlbum(album)).filter(Boolean),
      artists: [],
    };
  }
  if (types === 'artist') {
    const body = await get('/search/artist', { q, limit });
    return {
      tracks: [],
      albums: [],
      artists: (body?.data || []).map((artist) => toArtist(artist)).filter(Boolean),
    };
  }
  const body = await get('/search', { q, limit });
  return {
    tracks: (body?.data || []).map(toLightTrack).filter(Boolean),
    albums: [],
    artists: [],
  };
}

export async function getAlbumTracks(deezerId) {
  return cached(`deezer:album:${deezerId}`, 'deezer', async () => {
    const body = await get(`/album/${encodeURIComponent(deezerId)}`);
    const albumArtist = toArtist(body?.artist);
    const album = toAlbum(body, albumArtist);

    // The album payload embeds its track list, so this is one request rather
    // than one per track. Those entries carry a track position but not an ISRC;
    // the resolver hydrates whichever ones the user actually adds.
    const tracks = (body?.tracks?.data || []).map((track, index) => {
      const light = toLightTrack(track);
      if (!light) return null;
      return {
        ...light,
        album,
        trackNo: track.track_position ?? index + 1,
        discNo: track.disk_number ?? 1,
      };
    });

    return { album, tracks: tracks.filter(Boolean) };
  });
}

// Reads a playlist. Public playlists only - which is all that is possible
// without OAuth, and enough to import a shared or published playlist by URL.
// A private playlist returns an error body, which get() turns into a
// ProviderError with the provider's own wording.
export async function getPlaylist(deezerId) {
  const body = await get(`/playlist/${encodeURIComponent(deezerId)}`);

  // Deezer paginates a playlist's tracks. The first page is embedded; the rest
  // follow `next`, which is an absolute URL.
  const tracks = [...(body?.tracks?.data || [])];
  let next = body?.tracks?.next;
  // Bounded, so a pathological 10,000-track playlist cannot loop for minutes.
  for (let page = 0; next && page < 40; page++) {
    const more = await limiter(() =>
      fetchJson(next, { provider: 'deezer', timeoutMs: 15_000 })
    );
    for (const track of more?.data || []) tracks.push(track);
    next = more?.next;
  }

  return {
    playlist: {
      deezerId: String(body.id),
      name: body.title,
      description: body.description || null,
      trackCount: body.nb_tracks ?? tracks.length,
      owner: body.creator?.name || null,
      imageUrl: artwork(body) || body.picture_xl || null,
      public: body.public !== false,
    },
    tracks: tracks.map(toLightTrack).filter(Boolean),
  };
}

// Pulls the playlist id out of whatever the user pasted: a full URL, a share
// link, or just the number. Accepting all three is the difference between the
// feature working first time and the user having to work out which part matters.
export function parsePlaylistRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  // https://www.deezer.com/en/playlist/12345  |  https://deezer.page.link/...
  const match = /deezer\.[a-z.]+\/(?:[a-z]{2}\/)?playlist\/(\d+)/i.exec(raw);
  return match ? match[1] : null;
}

export async function getArtist(deezerId) {
  return cached(`deezer:artist:${deezerId}`, 'deezer', async () => {
    const body = await get(`/artist/${encodeURIComponent(deezerId)}`);
    return toArtist(body);
  });
}

// Used by the followed-artist check. Not cached: the entire point is to notice
// something that was not there yesterday.
export async function getArtistAlbums(deezerId, { limit = 50 } = {}) {
  const body = await get(`/artist/${encodeURIComponent(deezerId)}/albums`, { limit });
  return (body?.data || []).map((album) => toAlbum(album)).filter(Boolean);
}
