import { config } from '../config.js';
import { one, query } from '../db/pool.js';

// Shared plumbing for talking to external metadata APIs: retries, rate limiting
// and a durable response cache.

export class ProviderError extends Error {
  constructor(message, { status, provider, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A serial gate, used to honour MusicBrainz's roughly-one-request-per-second
// rule. Requests queue behind each other rather than being dropped, because for
// an import the correct behaviour is "slower", not "some tracks missing".
export function createRateLimiter(minIntervalMs) {
  let tail = Promise.resolve();
  let lastRun = 0;

  return function schedule(fn) {
    const result = tail.then(async () => {
      const wait = lastRun + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRun = Date.now();
      return fn();
    });
    // The queue must keep draining even when one request rejects, so the chain
    // that others wait on swallows the error; the caller still sees it.
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

// fetch with a timeout and bounded retries. Retries only on the failures that
// are actually transient - network errors, 429, and 5xx - because retrying a
// 404 just wastes a second and retrying a 401 hammers a bad credential.
export async function fetchJson(url, options = {}) {
  const {
    provider = 'unknown',
    timeoutMs = 15_000,
    retries = 2,
    headers = {},
    ...rest
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...rest,
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });

      if (response.status === 429) {
        // Respect the server's own backoff figure when it gives one.
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000;
        lastError = new ProviderError(`${provider} rate limited`, {
          status: 429,
          provider,
          retryable: true,
        });
        if (attempt < retries) {
          await sleep(Math.min(waitMs, 30_000));
          continue;
        }
        throw lastError;
      }

      if (response.status >= 500) {
        lastError = new ProviderError(`${provider} returned ${response.status}`, {
          status: response.status,
          provider,
          retryable: true,
        });
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ProviderError(
          `${provider} returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
          { status: response.status, provider }
        );
      }

      // 204 and other empty bodies are legitimate answers from some endpoints.
      if (response.status === 204) return null;
      return await response.json();
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      const aborted = err.name === 'AbortError';
      lastError =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              aborted ? `${provider} request timed out` : `${provider}: ${err.message}`,
              { provider, retryable: true }
            );
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Provider response cache
// ---------------------------------------------------------------------------
//
// Backed by Postgres rather than memory, so a restart does not throw away a
// large import's worth of lookups, and so a 300-track playlist re-import is
// nearly free. Metadata about released music barely changes, hence the long
// default TTL.

export async function cached(cacheKey, provider, loader, { ttlHours } = {}) {
  const ttl = ttlHours ?? config.providerCache.ttlHours;

  const hit = await one(
    `SELECT payload
       FROM provider_cache
      WHERE cache_key = $1
        AND fetched_at > now() - ($2 || ' hours')::interval`,
    [cacheKey, String(ttl)]
  );
  if (hit) return hit.payload;

  const payload = await loader();
  // null is a real, cacheable answer ("this provider does not know this
  // track"), and caching it is what stops a stubbornly unresolvable track from
  // re-querying the API on every single import.
  await query(
    `INSERT INTO provider_cache (cache_key, provider, payload, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (cache_key)
     DO UPDATE SET payload = EXCLUDED.payload,
                   fetched_at = EXCLUDED.fetched_at,
                   provider = EXCLUDED.provider`,
    [cacheKey, provider, JSON.stringify(payload ?? null)]
  );
  return payload;
}

export async function pruneProviderCache() {
  const { rowCount } = await query(
    `DELETE FROM provider_cache
      WHERE fetched_at < now() - ($1 || ' hours')::interval`,
    [String(config.providerCache.ttlHours * 2)]
  );
  return rowCount;
}
