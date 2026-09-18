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

function int(name, fallback) {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

// Turns TRUST_PROXY into the value Express expects.
//
//   unset / 0 / false          -> false   (no proxy; trust nothing)
//   1 / true                   -> 1       (one hop; only safe when the app is
//                                          ONLY reachable through the proxy)
//   "172.16.0.0/12,10.0.0.0/8" -> array   (trust these peers only)
function parseTrustProxy(raw) {
  const value = (raw || '').trim();
  if (value === '' || value === '0' || value.toLowerCase() === 'false') return false;
  if (value === '1' || value.toLowerCase() === 'true') return 1;
  const list = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : false;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 8080),

  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),

  // Trailing slashes produce double-slash URLs, which some services reject as
  // a mismatch. Normalise once here so nothing downstream has to think about it.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // Which peers are allowed to speak for someone else via X-Forwarded-For.
  //
  // This is a security setting, not a convenience one: whatever Express trusts
  // here becomes req.ip, and req.ip is what the rate limiter buckets on. Trust
  // too much and any client can rotate its apparent address and walk past the
  // login limiter.
  //
  // Accepts a list of trusted proxy addresses or CIDRs (preferred), or a plain
  // hop count. Prefer the list: this app can be reachable BOTH through a proxy
  // and directly on its published port at the same time, and a hop count cannot
  // tell those two cases apart - it would trust the header on the direct path
  // too. A CIDR covering only the proxy means the header is honoured when the
  // peer really is the proxy, and ignored otherwise.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Whether a device may be paired by sending the account password.
  //
  // Off, because nothing this project ships uses it. The local app pairs with a
  // short single-use code read off the web UI, which is the whole point of that
  // design: the password never leaves the browser it was typed into. The
  // password route exists for a headless box where reading a code off a page is
  // awkward, and it is a second door that accepts credentials on an instance
  // that may be on the public internet - so it is opt-in rather than something
  // every deployment exposes without knowing it is there.
  allowPasswordPairing: /^(1|true|yes|on)$/i.test(process.env.ALLOW_PASSWORD_PAIRING || ''),

  session: {
    cookieName: 'syncmypod_sid',
    // Long enough that a personal music library does not nag for a password
    // every day, short enough that a forgotten open tab is not permanent.
    ttlDays: int('SESSION_TTL_DAYS', 30),
  },

  // Provider CREDENTIALS are deliberately not here.
  //
  // They can be set either in the environment or from the Settings page, so the
  // effective value is not knowable at boot and must not be frozen into this
  // object. services/app-settings.js owns that decision - it reads the relevant
  // environment variable itself and lets it win over the stored value. See
  // musicbrainzConfig() and providerToggle() there.
  //
  // What stays here is only what is genuinely deployment-level and never
  // adjusted from the UI.
  musicbrainz: {
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

