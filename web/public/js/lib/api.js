// The one place the frontend talks to the server.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, options = {}) {
  const init = {
    method,
    headers: {},
    // The session cookie is HttpOnly, so it has to ride along explicitly.
    credentials: 'same-origin',
    signal: options.signal,
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, init);

  // A 401 anywhere means the session is gone - expired, or revoked by a
  // password change elsewhere. Handled centrally so no individual view has to.
  if (response.status === 401 && !options.allowUnauthorised) {
    window.dispatchEvent(new CustomEvent('syncmypod:unauthorised'));
  }

  // 204 and empty bodies are legitimate; JSON-parsing them throws.
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body from an /api path means something upstream intervened -
      // a proxy error page, usually. Surface it as-is rather than as a parse
      // error, which tells the user nothing.
      if (!response.ok) throw new ApiError(response.status, text.slice(0, 200));
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error || `Request failed (${response.status})`,
      payload
    );
  }
  return payload;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  // --- auth --------------------------------------------------------------
  state: () => request('GET', '/api/auth/state', undefined, { allowUnauthorised: true }),
  login: (username, password) =>
    request('POST', '/api/auth/login', { username, password }, { allowUnauthorised: true }),
  setup: (username, password, displayName) =>
    request('POST', '/api/auth/setup', { username, password, displayName }, { allowUnauthorised: true }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/api/auth/password', { currentPassword, newPassword }),

  // --- library -----------------------------------------------------------
  stats: () => request('GET', '/api/library/stats'),
  tracks: (params) => request('GET', `/api/library/tracks${qs(params)}`),
  track: (trackId) => request('GET', `/api/library/tracks/${trackId}`),
  addTracks: (payload) => request('POST', '/api/library/tracks', payload),
  removeTrack: (trackId) => request('DELETE', `/api/library/tracks/${trackId}`),
  updateTrack: (trackId, patch) => request('PATCH', `/api/library/tracks/${trackId}`, patch),
  resolveTrack: (trackId, options) =>
    request('POST', `/api/library/tracks/${trackId}/resolve`, options || {}),
  albums: (params) => request('GET', `/api/library/albums${qs(params)}`),
  artists: (params) => request('GET', `/api/library/artists${qs(params)}`),

  // --- playlists ---------------------------------------------------------
  playlists: () => request('GET', '/api/playlists'),
  playlist: (playlistId) => request('GET', `/api/playlists/${playlistId}`),
  createPlaylist: (payload) => request('POST', '/api/playlists', payload),
  updatePlaylist: (playlistId, patch) => request('PATCH', `/api/playlists/${playlistId}`, patch),
  deletePlaylist: (playlistId) => request('DELETE', `/api/playlists/${playlistId}`),
  addToPlaylist: (playlistId, trackIds) =>
    request('POST', `/api/playlists/${playlistId}/tracks`, { trackIds }),
  removeFromPlaylist: (playlistId, trackId) =>
    request('DELETE', `/api/playlists/${playlistId}/tracks/${trackId}`),
  reorderPlaylist: (playlistId, trackIds) =>
    request('PUT', `/api/playlists/${playlistId}/order`, { trackIds }),

  // --- search ------------------------------------------------------------
  searchCatalogue: (q, signal) =>
    request('GET', `/api/search/catalogue${qs({ q })}`, undefined, { signal }),
  searchProviders: (q, type, signal) =>
    request('GET', `/api/search/providers${qs({ q, type })}`, undefined, { signal }),
  providerAlbum: (params) => request('GET', `/api/search/album${qs(params)}`),
  providerArtist: (deezerId) => request('GET', `/api/search/artist${qs({ deezerId })}`),
  // Asked for by name rather than run with every search - see the comment on
  // the route. Slower, and its metadata is a video title.
  followImportStatus: (artistId) =>
    request('GET', `/api/artists/follows/${artistId}/import`),
  searchYouTube: (q, signal) =>
    request('GET', `/api/search/youtube${qs({ q })}`, undefined, { signal }),

  // --- artists / follows -------------------------------------------------
  follows: () => request('GET', '/api/artists/follows'),
  follow: (payload) => request('POST', '/api/artists/follows', payload),
  unfollow: (artistId) => request('DELETE', `/api/artists/follows/${artistId}`),
  checkFollow: (artistId) => request('POST', `/api/artists/follows/${artistId}/check`),
  artist: (artistId) => request('GET', `/api/artists/${artistId}`),

  // --- devices -----------------------------------------------------------
  devices: () => request('GET', '/api/devices'),
  pair: () => request('POST', '/api/devices/pair'),
  revokeDevice: (deviceId) => request('DELETE', `/api/devices/${deviceId}`),
  deviceHistory: (deviceId) => request('GET', `/api/devices/${deviceId}/history`),

  // --- import ------------------------------------------------------------
  previewTrackList: (text, order) => request('POST', '/api/import/preview', { text, order }),
  importTrackList: (payload) => request('POST', '/api/import/track-list', payload),
  importDeezerPlaylist: (payload) => request('POST', '/api/import/deezer-playlist', payload),
  importYouTubePlaylist: (payload) =>
    request('POST', '/api/import/youtube-playlist', payload),
  importJobs: () => request('GET', '/api/import/jobs'),

  suggestArtists: (q) => request('GET', `/api/suggest/artists?q=${encodeURIComponent(q)}`),
  suggestAlbums: (q) => request('GET', `/api/suggest/albums?q=${encodeURIComponent(q)}`),
  unresolvedCount: () => request('GET', '/api/library/unresolved/count'),
  combinedArtistCount: () => request('GET', '/api/artists/combined/count'),
  repairCombinedArtists: () => request('POST', '/api/artists/combined/repair'),
  rematchUnresolved: () => request('POST', '/api/library/unresolved/rematch'),

  // --- standing sources ---------------------------------------------------
  sources: () => request('GET', '/api/sources'),
  addSource: (url) => request('POST', '/api/sources', { url }),
  checkSource: (sourceId) => request('POST', `/api/sources/${sourceId}/check`),
  setSourceEnabled: (sourceId, enabled) =>
    request('PATCH', `/api/sources/${sourceId}`, { enabled }),
  removeSource: (sourceId) => request('DELETE', `/api/sources/${sourceId}`),

  // --- connected YouTube account -----------------------------------------
  youtubeAccount: () => request('GET', '/api/youtube-account'),
  youtubeConnect: () => request('POST', '/api/youtube-account/connect'),
  youtubeDisconnect: () => request('POST', '/api/youtube-account/disconnect'),
  youtubeRefreshPlaylists: () => request('POST', '/api/youtube-account/refresh'),
  youtubeSelection: (playlistIds) =>
    request('PUT', '/api/youtube-account/selection', { playlistIds }),
  youtubeSyncNow: () => request('POST', '/api/youtube-account/sync'),
  importJob: (jobId) => request('GET', `/api/import/jobs/${jobId}`),

  // --- instance settings -------------------------------------------------
  settings: () => request('GET', '/api/settings'),
  saveSettings: (settings) => request('PUT', '/api/settings', { settings }),
  testProvider: (provider) => request('POST', `/api/settings/test/${provider}`),

  health: () => request('GET', '/api/health', undefined, { allowUnauthorised: true }),
};
