import { config } from '../config.js';
import { many, query } from '../db/pool.js';

// Instance configuration: provider credentials and the MusicBrainz contact,
// editable from the Settings page instead of only from a .env file.
//
// Three things this file has to get right.
//
// 1. READS MUST BE SYNCHRONOUS. isEnabled() is called from route handlers, the
//    health check and the resolver's hot path. Making those async would ripple
//    through every call site for no benefit, so the whole table is cached in
//    memory, loaded once at boot and refreshed on every write. It is a handful
//    of rows that change by hand, so the cache can never be meaningfully stale.
//
// 2. ENVIRONMENT WINS. If a value is set in the environment, that is what the
//    deployment's own config management says it should be, and the UI must not
//    silently override it - it shows the value as locked instead. Anything not
//    set in the environment is editable in the UI. This keeps both worlds
//    working: docker-compose-driven deployments stay declarative, and a
//    hand-run instance is configurable without SSH.
//
// 3. SECRETS NEVER GO BACK OUT. The API returns whether a secret is set and a
//    short prefix, never the value, for the same reason a password is hashed.

// Every key the app understands, with how it behaves.
//
// `secret: true` means the value is never returned to a client.
// `env` names the environment variable that takes precedence over the database.
const SCHEMA = {
  'musicbrainz.contact': { env: 'MUSICBRAINZ_CONTACT', secret: false, label: 'MusicBrainz contact' },
  // Deezer and iTunes need no credentials, so there is nothing to configure -
  // only whether to use them. Stored as the string "true"/"false"; absent means
  // the default, which is on, since a provider that costs nothing to enable and
  // needs no account should not require a decision before the app is useful.
  'deezer.enabled': { env: 'DEEZER_ENABLED', secret: false, label: 'Use Deezer', boolean: true },
  'itunes.enabled': { env: 'ITUNES_ENABLED', secret: false, label: 'Use iTunes', boolean: true },
};

export const SETTING_KEYS = Object.keys(SCHEMA);

// key -> value from the database. Loaded at boot, kept current on write.
const cache = new Map();
let loaded = false;

export async function loadSettings() {
  const rows = await many('SELECT key, value FROM app_settings');
  cache.clear();
  for (const row of rows) {
    if (SCHEMA[row.key]) cache.set(row.key, row.value);
  }
  loaded = true;
  return cache.size;
}

// The value actually in force, and where it came from.
export function resolve(key) {
  const spec = SCHEMA[key];
  if (!spec) return { value: '', source: 'unknown' };

  const fromEnv = (process.env[spec.env] || '').trim();
  if (fromEnv) return { value: fromEnv, source: 'env' };

  const stored = cache.get(key);
  const value = typeof stored === 'string' ? stored.trim() : '';
  return { value, source: value ? 'database' : 'unset' };
}

export function get(key) {
  return resolve(key).value;
}

// Writes the given keys. A key whose value is set in the environment is
// rejected rather than silently ignored, so the UI can explain why.
export async function setMany(updates, userId) {
  if (!loaded) await loadSettings();

  const applied = [];
  const rejected = [];

  for (const [key, raw] of Object.entries(updates)) {
    const spec = SCHEMA[key];
    if (!spec) {
      rejected.push({ key, reason: 'Unknown setting.' });
      continue;
    }
    if ((process.env[spec.env] || '').trim()) {
      rejected.push({
        key,
        reason: `${spec.label} is set by the ${spec.env} environment variable and cannot be changed here.`,
      });
      continue;
    }

    const value = typeof raw === 'string' ? raw.trim() : '';

    if (value === '') {
      // Clearing a setting is a legitimate action - it turns the provider off.
      await query('DELETE FROM app_settings WHERE key = $1', [key]);
      cache.delete(key);
      applied.push({ key, cleared: true });
      continue;
    }

    await query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), userId || null]
    );
    cache.set(key, value);
    applied.push({ key, cleared: false });
  }

  // Anything holding derived state from these values has to be told.
  for (const listener of listeners) listener(applied.map((entry) => entry.key));

  return { applied, rejected };
}

// Notified after a write, so a provider can drop a cached access token or
// rebuild a User-Agent string rather than carrying on with stale credentials.
const listeners = new Set();
export function onSettingsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// What the Settings page renders. Secrets are reported as set/unset with a
// short prefix, never as a value.
export function describe() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const { value, source } = resolve(key);
    out[key] = {
      label: spec.label,
      source,
      // A value that comes from the environment cannot be edited here, so the
      // UI can disable the field and say why rather than accepting an edit and
      // appearing to lose it.
      editable: source !== 'env',
      envVar: spec.env,
      isSet: Boolean(value),
      // A toggle reports its effective state, including the default, so the UI
      // renders a checkbox that reflects reality rather than an empty field.
      ...(spec.boolean ? { boolean: true, checked: providerToggle(key.split('.')[0]) } : {}),
      ...(spec.secret
        ? { secret: true, hint: value ? `${value.slice(0, 4)}...${value.slice(-2)}` : null }
        : { secret: false, value }),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effective provider configuration
// ---------------------------------------------------------------------------
//
// Providers read these rather than `config`, so a value typed into the UI takes
// effect on the next request with no restart.
//
// Only MusicBrainz has anything to configure. Deezer and iTunes need no account
// or key at all, so for them the only question is on or off - see
// providerToggle. There is deliberately no credential plumbing left for a
// provider that does not need any.

// Whether a credential-free provider is switched on. Absent means on: there is
// nothing to configure, so requiring an explicit opt-in would only leave a
// fresh instance less capable for no reason.
export function providerToggle(name) {
  const { value } = resolve(`${name}.enabled`);
  if (value === '') return true;
  return value !== 'false' && value !== '0';
}

export function musicbrainzConfig() {
  const contact = get('musicbrainz.contact');
  return {
    contact,
    // A missing contact means the provider stays off. MusicBrainz asks every
    // client to be contactable and throttles those that are not, so the honest
    // options are "identify yourself" or "do not call" - never a fake agent.
    enabled: Boolean(contact),
    userAgent: `SyncMyPod/0.1.0 ( ${contact || 'unconfigured'} )`,
    minIntervalMs: config.musicbrainz.minIntervalMs,
  };
}
