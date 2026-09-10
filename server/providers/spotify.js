import { config, spotifyRedirectUri } from '../config.js';
import { one, query } from '../db/pool.js';
import { cached, fetchJson, ProviderError } from '../lib/http.js';
import { yearFromDate } from '../lib/normalise.js';

// Spotify Web API client.
//
// Two distinct kinds of access, kept separate on purpose:
//
//   * CLIENT CREDENTIALS - an app-level token, no user involved. Covers search
//     and track/album/artist lookup, which is everything the metadata resolver
//     needs. Works the moment a client id and secret exist.
//
//   * USER AUTHORISATION - a per-user token from the authorization code flow.
//     Needed only to read that user's own playlists and follows, because those
//     are private data the app token cannot see.
//
// The resolver depends only on the first, so metadata resolution keeps working
// even if nobody ever links their Spotify account.

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

export const USER_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-follow-read',
].join(' ');

export function isEnabled() {
  return config.spotify.enabled;
}

// ---------------------------------------------------------------------------
// App token (client credentials)
// ---------------------------------------------------------------------------

let appToken = null; // { value, expiresAt }

async function getAppToken() {
  if (!config.spotify.enabled) {
    throw new ProviderError(
      'Spotify is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
      { provider: 'spotify', status: 503 }
    );
  }
  // 60s of slack, so a token does not expire mid-flight on a slow request.
  if (appToken && appToken.expiresAt > Date.now() + 60_000) {
    return appToken.value;
  }

  const basic = Buffer.from(
    `${config.spotify.clientId}:${config.spotify.clientSecret}`
  ).toString('base64');

  const body = await fetchJson(`${ACCOUNTS}/api/token`, {
    provider: 'spotify',
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  appToken = {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return appToken.value;
}

async function apiGet(path, { token, params } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const bearer = token || (await getAppToken());
  return fetchJson(url.toString(), {
    provider: 'spotify',
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

// ---------------------------------------------------------------------------
// Shape conversion
// ---------------------------------------------------------------------------
//
// Everything below returns the app's own normalised shape, never a raw Spotify
// object. That boundary is what lets MusicBrainz be a genuine drop-in fallback
// and keeps provider quirks from leaking into the database layer.

function artworkFrom(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  // Spotify orders images widest-first. The largest is the right choice even for
  // a 320x240 iPod screen, because the local app resizes when it writes the tag
  // and downscaling from a good source beats upscaling a thumbnail.
  return images[0].url || null;
}

function toArtist(artist) {
  return {
    provider: 'spotify',
    spotifyId: artist.id || null,
    name: artist.name,
    imageUrl: artworkFrom(artist.images),
    genres: Array.isArray(artist.genres) ? artist.genres : null,
  };
}

function toAlbum(album) {
  if (!album) return null;
  return {
    provider: 'spotify',
    spotifyId: album.id || null,
    name: album.name,
    releaseDate: album.release_date || null,
    releaseYear: yearFromDate(album.release_date),
    artworkUrl: artworkFrom(album.images),
    totalTracks: album.total_tracks ?? null,
    albumType: album.album_type || null,
    artists: (album.artists || []).map(toArtist),
  };
}

function toTrack(track) {
  if (!track || !track.id) return null;

  // Spotify's `artists` array is ordered, with the primary artist first and any
  // featured artists after. That ordering is the thing raw download-source
  // metadata destroys, so it is preserved explicitly here.
  const artists = (track.artists || []).map((artist, index) => ({
    ...toArtist(artist),
    position: index,
    role: index === 0 ? 'primary' : 'featured',
  }));

  return {
    provider: 'spotify',
    spotifyId: track.id,
    isrc: track.external_ids?.isrc || null,
    title: track.name,
    durationMs: track.duration_ms ?? null,
    trackNo: track.track_number ?? null,
    discNo: track.disc_number ?? null,
    explicit: Boolean(track.explicit),
    artists,
    album: toAlbum(track.album),
    // Handy for the UI to link back to the source of a resolved record.
    externalUrl: track.external_urls?.spotify || null,
  };
}

// ---------------------------------------------------------------------------
// Lookups used by the resolver
// ---------------------------------------------------------------------------

// The strongest match available. An ISRC identifies a specific recording
// globally, so a hit here needs no scoring or confirmation.
export async function findByIsrc(isrc) {
  const clean = String(isrc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 12) return null;

  return cached(`spotify:isrc:${clean}`, 'spotify', async () => {
    const body = await apiGet('/search', {
      params: { q: `isrc:${clean}`, type: 'track', limit: 5 },
    });
    const items = body?.tracks?.items || [];
    if (items.length === 0) return null;
    // More than one result means the same recording on several releases (a
    // single and an album, say). Prefer the album, since it carries a track
    // number and a proper album name for the tag.
    const best =
      items.find((item) => item.album?.album_type === 'album') || items[0];
    return toTrack(best);
  });
}

export async function searchTracks({ title, artist, album, limit = 10 }) {
  const terms = [];
  if (title) terms.push(`track:${JSON.stringify(String(title))}`);
  if (artist) terms.push(`artist:${JSON.stringify(String(artist))}`);
  if (album) terms.push(`album:${JSON.stringify(String(album))}`);
  const q = terms.length > 0 ? terms.join(' ') : String(title || '');

  const key = `spotify:search:${config.spotify.market}:${limit}:${q}`;
  return cached(key, 'spotify', async () => {
    const body = await apiGet('/search', {
      params: { q, type: 'track', limit, market: config.spotify.market },
    });
    return (body?.tracks?.items || []).map(toTrack).filter(Boolean);
  });
}

// Free-text search for the UI's search box, where the user is browsing rather
// than resolving a known track. Not cached as aggressively, because a person
// typing expects their query to be treated as new.
export async function searchAll(q, { types = 'track', limit = 20 } = {}) {
  const body = await apiGet('/search', {
    params: { q, type: types, limit, market: config.spotify.market },
  });
  return {
    tracks: (body?.tracks?.items || []).map(toTrack).filter(Boolean),
    albums: (body?.albums?.items || []).map(toAlbum).filter(Boolean),
    artists: (body?.artists?.items || []).map(toArtist).filter(Boolean),
  };
}

export async function getTrack(spotifyId) {
  return cached(`spotify:track:${spotifyId}`, 'spotify', async () => {
    const body = await apiGet(`/tracks/${encodeURIComponent(spotifyId)}`, {
      params: { market: config.spotify.market },
    });
    return toTrack(body);
  });
}

export async function getAlbumTracks(spotifyId) {
  return cached(`spotify:album-tracks:${spotifyId}`, 'spotify', async () => {
    const album = await apiGet(`/albums/${encodeURIComponent(spotifyId)}`, {
      params: { market: config.spotify.market },
    });

    // The album endpoint returns a first page of simplified track objects that
    // omit `album` and `external_ids`. Rather than paginate that and then fetch
    // each track individually, collect the ids and batch them through /tracks,
    // which returns the full objects 50 at a time.
    const ids = [];
    let page = album?.tracks;
    while (page) {
      for (const item of page.items || []) if (item?.id) ids.push(item.id);
      page = page.next
        ? await fetchJson(page.next, {
            provider: 'spotify',
            headers: { Authorization: `Bearer ${await getAppToken()}` },
          })
        : null;
    }

    const tracks = [];
    for (let i = 0; i < ids.length; i += 50) {
      const body = await apiGet('/tracks', {
        params: { ids: ids.slice(i, i + 50).join(','), market: config.spotify.market },
      });
      for (const track of body?.tracks || []) {
        const mapped = toTrack(track);
        if (mapped) tracks.push(mapped);
      }
    }
    return { album: toAlbum(album), tracks };
  });
}

export async function getArtist(spotifyId) {
  return cached(`spotify:artist:${spotifyId}`, 'spotify', async () => {
    const body = await apiGet(`/artists/${encodeURIComponent(spotifyId)}`);
    return toArtist(body);
  });
}

// Used by the followed-artist check. Not cached, because the entire point is to
// notice something that was not there yesterday.
export async function getArtistAlbums(
  spotifyId,
  { includeGroups = 'album,single', limit = 50 } = {}
) {
  const albums = [];
  let url = null;
  let body = await apiGet(`/artists/${encodeURIComponent(spotifyId)}/albums`, {
    params: {
      include_groups: includeGroups,
      limit,
      market: config.spotify.market,
    },
  });
  while (body) {
    for (const album of body.items || []) {
      const mapped = toAlbum(album);
      if (mapped) albums.push(mapped);
    }
    url = body.next;
    body = url
      ? await fetchJson(url, {
          provider: 'spotify',
          headers: { Authorization: `Bearer ${await getAppToken()}` },
        })
      : null;
  }
  return albums;
}

// ---------------------------------------------------------------------------
// User authorisation (for importing the user's own playlists)
// ---------------------------------------------------------------------------

export function authorizeUrl(req, state) {
  const url = new URL(`${ACCOUNTS}/authorize`);
  url.searchParams.set('client_id', config.spotify.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', spotifyRedirectUri(req));
  url.searchParams.set('scope', USER_SCOPES);
  url.searchParams.set('state', state);
  // Force the account chooser, so a household with two Spotify accounts does
  // not silently link whichever one the browser remembers.
  url.searchParams.set('show_dialog', 'true');
  return url.toString();
}

export async function exchangeCode(req, code) {
  const basic = Buffer.from(
    `${config.spotify.clientId}:${config.spotify.clientSecret}`
  ).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotifyRedirectUri(req),
  });

  const body = await fetchJson(`${ACCOUNTS}/api/token`, {
    provider: 'spotify',
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    retries: 0, // An authorization code is single-use; retrying cannot succeed.
  });

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    scopes: body.scope || USER_SCOPES,
  };
}

// Returns a usable access token for this user, refreshing it first if needed.
// Refresh is transparent to callers so no import has to think about expiry.
export async function userAccessToken(userId) {
  const row = await one(
    `SELECT access_token, refresh_token, expires_at
       FROM oauth_accounts
      WHERE user_id = $1 AND provider = 'spotify'`,
    [userId]
  );
  if (!row) {
    throw new ProviderError('Spotify account is not linked.', {
      provider: 'spotify',
      status: 400,
    });
  }

  if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    return row.access_token;
  }
  if (!row.refresh_token) {
    throw new ProviderError('Spotify authorisation expired. Link the account again.', {
      provider: 'spotify',
      status: 401,
    });
  }

  const basic = Buffer.from(
    `${config.spotify.clientId}:${config.spotify.clientSecret}`
  ).toString('base64');

  const body = await fetchJson(`${ACCOUNTS}/api/token`, {
    provider: 'spotify',
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }).toString(),
  });

  // Spotify sometimes rotates the refresh token and sometimes does not, so keep
  // the old one when no replacement comes back.
  await query(
    `UPDATE oauth_accounts
        SET access_token = $2,
            refresh_token = COALESCE($3, refresh_token),
            expires_at = $4
      WHERE user_id = $1 AND provider = 'spotify'`,
    [
      userId,
      body.access_token,
      body.refresh_token || null,
      new Date(Date.now() + body.expires_in * 1000),
    ]
  );
  return body.access_token;
}

export async function getMe(accessToken) {
  return apiGet('/me', { token: accessToken });
}

export async function getMyPlaylists(userId) {
  const token = await userAccessToken(userId);
  const playlists = [];
  let body = await apiGet('/me/playlists', { token, params: { limit: 50 } });
  while (body) {
    for (const item of body.items || []) {
      if (!item) continue;
      playlists.push({
        spotifyId: item.id,
        name: item.name,
        description: item.description || null,
        trackCount: item.tracks?.total ?? null,
        owner: item.owner?.display_name || null,
        imageUrl: artworkFrom(item.images),
        public: item.public,
      });
    }
    body = body.next
      ? await fetchJson(body.next, {
          provider: 'spotify',
          headers: { Authorization: `Bearer ${token}` },
        })
      : null;
  }
  return playlists;
}

export async function getPlaylistTracks(userId, playlistId) {
  const token = await userAccessToken(userId);

  const meta = await apiGet(`/playlists/${encodeURIComponent(playlistId)}`, {
    token,
    params: { fields: 'id,name,description,owner(display_name),tracks(total)' },
  });

  const tracks = [];
  let body = await apiGet(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    token,
    params: { limit: 100, market: config.spotify.market },
  });
  while (body) {
    for (const item of body.items || []) {
      // Local files and podcast episodes appear in playlists with no usable
      // track object. Skipping them is correct: there is nothing to resolve.
      if (!item?.track || item.track.type !== 'track' || item.track.is_local) continue;
      const mapped = toTrack(item.track);
      if (mapped) tracks.push(mapped);
    }
    body = body.next
      ? await fetchJson(body.next, {
          provider: 'spotify',
          headers: { Authorization: `Bearer ${token}` },
        })
      : null;
  }

  return {
    playlist: {
      spotifyId: meta.id,
      name: meta.name,
      description: meta.description || null,
      owner: meta.owner?.display_name || null,
      total: meta.tracks?.total ?? tracks.length,
    },
    tracks,
  };
}

export async function getMySavedTracks(userId) {
  const token = await userAccessToken(userId);
  const tracks = [];
  let body = await apiGet('/me/tracks', {
    token,
    params: { limit: 50, market: config.spotify.market },
  });
  while (body) {
    for (const item of body.items || []) {
      const mapped = toTrack(item?.track);
      if (mapped) tracks.push(mapped);
    }
    body = body.next
      ? await fetchJson(body.next, {
          provider: 'spotify',
          headers: { Authorization: `Bearer ${token}` },
        })
      : null;
  }
  return tracks;
}

export async function getMyFollowedArtists(userId) {
  const token = await userAccessToken(userId);
  const artists = [];
  let body = await apiGet('/me/following', {
    token,
    params: { type: 'artist', limit: 50 },
  });
  while (body?.artists) {
    for (const artist of body.artists.items || []) artists.push(toArtist(artist));
    body = body.artists.next
      ? await fetchJson(body.artists.next, {
          provider: 'spotify',
          headers: { Authorization: `Bearer ${token}` },
        })
      : null;
  }
  return artists;
}
