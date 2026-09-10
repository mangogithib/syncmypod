// Every environment variable the app reads, in one place, validated at boot.
//
// The rule here is that a misconfigured instance should fail loudly on startup
// rather than quietly at 2am when someone tries to log in. So anything the app
// genuinely cannot run without throws immediately; anything optional degrades to
// a documented, inspectable "off" state that the UI can report.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function int(name, fallback) {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

const spotifyClientId = process.env.SPOTIFY_CLIENT_ID || '';
const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 8080),

  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),

  // Trailing slashes cause double-slash redirect URIs, which Spotify rejects as
  // a mismatch. Normalise once here so nothing downstream has to think about it.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: bool('TRUST_PROXY', false),

  session: {
    cookieName: 'syncmypod_sid',
    // Long enough that a personal music library does not nag for a password
    // every day, short enough that a forgotten open tab is not permanent.
    ttlDays: int('SESSION_TTL_DAYS', 30),
  },

  spotify: {
    clientId: spotifyClientId,
    clientSecret: spotifyClientSecret,
    // Search and metadata resolution need only the client credentials grant.
    enabled: Boolean(spotifyClientId && spotifyClientSecret),
    // Importing the user's own playlists additionally needs a redirect URI
    // registered on the Spotify app, so it is tracked as a separate capability.
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
    // Optional, and empty by default. Spotify uses `market` to decide which
    // tracks count as available and to relink regional duplicates. Left unset,
    // the parameter is omitted and search returns everything, which is what a
    // metadata-only tool wants - we never play the audio, so playability in a
    // given country is irrelevant. Set it per deployment only if a specific
    // market genuinely gives better matches for that library.
    market: process.env.SPOTIFY_MARKET || '',
  },

  musicbrainz: {
    // MusicBrainz asks every client to identify itself with a contactable
    // address and throttles or blocks those that do not. Rather than send a
    // fake one, treat a missing contact as "provider unavailable" and say so
    // in the UI.
    contact: process.env.MUSICBRAINZ_CONTACT || '',
    enabled: Boolean(process.env.MUSICBRAINZ_CONTACT),
    userAgent: `SyncMyPod/0.1.0 ( ${process.env.MUSICBRAINZ_CONTACT || 'unconfigured'} )`,
    // Their published limit is ~1 request/second averaged. 1100ms leaves headroom
    // for clock jitter without being needlessly slow.
    minIntervalMs: int('MUSICBRAINZ_MIN_INTERVAL_MS', 1100),
  },

  // How multiple artists are joined into the single string written to the iPod
  // tag. Configurable because the concept lists this as an open question and the
  // right answer depends on how a given iPod generation renders it.
  artistJoin: process.env.ARTIST_JOIN || ', ',

  providerCache: {
    ttlHours: int('PROVIDER_CACHE_TTL_HOURS', 24 * 14),
  },
};

// Where this instance thinks it lives. Used for OAuth redirects and for the
// pairing details handed to the local app.
export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = config.trustProxy
    ? req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol
    : req.protocol;
  const host = config.trustProxy
    ? req.headers['x-forwarded-host'] || req.headers.host
    : req.headers.host;
  return `${proto}://${host}`;
}

// The Spotify redirect URI, preferring the explicit setting. Falling back to a
// request-derived value means OAuth works on a test box before anyone has set
// PUBLIC_URL, but Spotify still requires the exact string to be registered.
export function spotifyRedirectUri(req) {
  if (config.spotify.redirectUri) return config.spotify.redirectUri;
  return `${baseUrl(req)}/api/import/spotify/callback`;
}
