import { musicbrainzConfig as settings } from '../services/app-settings.js';
import { config } from '../config.js';
import { cached, createRateLimiter, fetchJson, ProviderError } from '../lib/http.js';
import { yearFromDate } from '../lib/normalise.js';

// MusicBrainz client - the fallback provider.
//
// Used when Deezer and iTunes have no answer. It returns the same normalised
// shape as the other providers, so the resolver does not care which one
// answered.
//
// Two things about MusicBrainz shape the code here:
//
//   1. It asks every client for a contactable User-Agent and throttles clients
//      that ignore roughly one request per second. Both are honoured: the
//      limiter below serialises every call, and a missing contact disables the
//      provider rather than sending a fake agent string.
//
//   2. Its data model is release-oriented, not album-oriented. A recording can
//      appear on many releases, so picking one is a judgement call - made
//      explicitly in pickRelease below rather than by taking the first result.

const WS = 'https://musicbrainz.org/ws/2';
const COVER_ART = 'https://coverartarchive.org';

const limiter = createRateLimiter(config.musicbrainz.minIntervalMs);

export function isEnabled() {
  return settings().enabled;
}

async function ws(path, params = {}) {
  if (!settings().enabled) {
    throw new ProviderError(
      'MusicBrainz is not configured. Set MUSICBRAINZ_CONTACT to an email or project URL.',
      { provider: 'musicbrainz', status: 503 }
    );
  }

  const url = new URL(`${WS}${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return limiter(() =>
    fetchJson(url.toString(), {
      provider: 'musicbrainz',
      headers: { 'User-Agent': settings().userAgent },
      timeoutMs: 20_000,
    })
  );
}

// ---------------------------------------------------------------------------
// Shape conversion
// ---------------------------------------------------------------------------

function toArtists(artistCredit) {
  // artist-credit is an ordered list of { artist, joinphrase }. The order is the
  // credit order, so the first entry is the primary artist and the rest are
  // features - the same convention every provider here produces.
  return (artistCredit || []).map((credit, index) => ({
    provider: 'musicbrainz',
    mbid: credit.artist?.id || null,
    name: credit.artist?.name || credit.name || '',
    position: index,
    role: index === 0 ? 'primary' : 'featured',
  }));
}

// A recording may be on a dozen releases: the original album, three
// compilations, a deluxe edition, a single. For an iPod tag the original studio
// album is almost always the right answer, so releases are ranked rather than
// taken in whatever order the API returned.
function pickRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;

  const scored = releases.map((release) => {
    let score = 0;
    const primaryType = release['release-group']?.['primary-type'];
    const secondaryTypes = release['release-group']?.['secondary-types'] || [];

    if (primaryType === 'Album') score += 3;
    else if (primaryType === 'EP') score += 2;
    else if (primaryType === 'Single') score += 1;

    // Compilations, live records and soundtracks are real releases but the
    // wrong album name to burn into a tag when a studio album exists.
    if (secondaryTypes.includes('Compilation')) score -= 3;
    if (secondaryTypes.includes('Live')) score -= 2;

    if (release.status === 'Official') score += 2;
    // Earliest release wins ties: that is the original, not a reissue.
    const year = yearFromDate(release.date);
    if (year) score += (2100 - year) / 10_000;

    return { release, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].release;
}

// How unlike "the studio recording someone actually meant" this release is.
//
// pickRelease chooses the best release WITHIN one recording, but MusicBrainz
// models every live performance as its own recording, so a search for
// "Karma Police" returns the studio take alongside a dozen bootlegs - all with
// an identical title and artist, and therefore an identical match score. Left
// to that, a bootleg wins on nothing more than result order.
//
// So the provider reports a penalty and the resolver subtracts it when ranking
// candidates. It lives here rather than in the scorer because "bootleg" and
// "secondary-types" are MusicBrainz concepts; the scorer stays provider-neutral
// and simply honours the number if a provider supplies one.
function qualityPenalty(release) {
  if (!release) return 0.15; // No release at all is weak evidence.

  let penalty = 0;
  const secondaryTypes = release['release-group']?.['secondary-types'] || [];

  // Not an official release: a bootleg, a promo, a withdrawn pressing.
  if (release.status && release.status !== 'Official') penalty += 0.35;
  if (secondaryTypes.includes('Live')) penalty += 0.3;
  if (secondaryTypes.includes('Demo')) penalty += 0.2;
  if (secondaryTypes.includes('Compilation')) penalty += 0.1;

  // Bootleg concert releases are conventionally titled by date and venue
  // ("2003-06-04: Electric Lady Studios"). Catching that covers the ones with
  // no status or type set at all, which is common for user-added bootlegs.
  if (/^\d{4}[-‐-―.\/]\d{2}[-‐-―.\/]\d{2}/.test(release.title || '')) {
    penalty += 0.3;
  }

  return Math.min(penalty, 0.8);
}

function toAlbumFromRelease(release) {
  if (!release) return null;
  const media = release.media?.[0];
  return {
    provider: 'musicbrainz',
    mbid: release.id || null,
    // release-group is the "album as a work"; the release is one edition of it.
    releaseGroupMbid: release['release-group']?.id || null,
    name: release.title,
    releaseDate: release.date || null,
    releaseYear: yearFromDate(release.date),
    totalTracks: media?.['track-count'] ?? release['track-count'] ?? null,
    albumType: (release['release-group']?.['primary-type'] || '').toLowerCase() || null,
    artists: toArtists(release['artist-credit']),
    // Cover Art Archive is addressed by release mbid. Constructed rather than
    // fetched: an extra request per track to discover a 404 is not worth it, and
    // the local app has to handle a missing artwork URL regardless.
    artworkUrl: release.id ? `${COVER_ART}/release/${release.id}/front-500` : null,
  };
}

function toTrack(recording) {
  if (!recording?.id) return null;

  const release = pickRelease(recording.releases);
  const album = toAlbumFromRelease(release);

  // Track and disc numbers live on the release, not the recording, so they come
  // from whichever release was chosen above.
  const media = release?.media?.[0];
  const trackEntry = media?.track?.[0];

  return {
    provider: 'musicbrainz',
    mbid: recording.id,
    isrc: recording.isrcs?.[0] || null,
    title: recording.title,
    durationMs: recording.length ?? null,
    trackNo: trackEntry?.number ? Number(trackEntry.number) || null : null,
    discNo: media?.position ?? null,
    explicit: null, // MusicBrainz does not model this.
    artists: toArtists(recording['artist-credit']),
    album,
    // Subtracted by the resolver when ranking candidates. See qualityPenalty.
    qualityPenalty: qualityPenalty(release),
    externalUrl: `https://musicbrainz.org/recording/${recording.id}`,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function findByIsrc(isrc) {
  const clean = String(isrc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 12) return null;

  return cached(`mb:isrc:${clean}`, 'musicbrainz', async () => {
    const body = await ws(`/isrc/${clean}`, {
      inc: 'artist-credits+releases+release-groups+media+isrcs',
    });
    const recording = body?.recordings?.[0];
    return recording ? toTrack(recording) : null;
  });
}

// Lucene query syntax. Quoting matters: an unquoted title with a colon or a
// hyphen in it becomes a field query or a negation and returns nothing.
function luceneTerm(field, value) {
  const escaped = String(value).replace(/(["\\])/g, '\\$1');
  return `${field}:"${escaped}"`;
}

export async function searchTracks({ title, artist, album, limit = 10 }) {
  const terms = [];
  if (title) terms.push(luceneTerm('recording', title));
  if (artist) terms.push(luceneTerm('artist', artist));
  if (album) terms.push(luceneTerm('release', album));
  if (terms.length === 0) return [];

  const q = terms.join(' AND ');
  // v2: the cache key is versioned so a change to how results are ranked is not
  // masked for a fortnight by previously cached responses.
  return cached(`mb:search:v2:${limit}:${q}`, 'musicbrainz', async () => {
    const body = await ws('/recording', { query: q, limit });
    const recordings = body?.recordings || [];

    // The search endpoint returns recordings with releases attached but without
    // media detail, which is enough to judge a candidate.
    const tracks = recordings.map(toTrack).filter(Boolean);

    // Ranked by release quality before returning, not just by MusicBrainz's own
    // relevance score.
    //
    // MusicBrainz models every live performance as its own recording, so a
    // search for a well-known song returns the studio take buried among a dozen
    // identically-titled bootlegs, all scored 100 for relevance. The resolver
    // applies the same penalty when picking a match, but this list is also shown
    // directly in the "Add music" screen - and putting a bootleg concert
    // recording at the top of that list is simply wrong.
    //
    // A stable sort, so MusicBrainz's own ordering still decides between
    // candidates of equal quality.
    return tracks
      .map((track, index) => ({ track, index }))
      .sort(
        (a, b) =>
          (a.track.qualityPenalty || 0) - (b.track.qualityPenalty || 0) ||
          a.index - b.index
      )
      .map((entry) => entry.track);
  });
}

export async function getRecording(mbid) {
  return cached(`mb:recording:${mbid}`, 'musicbrainz', async () => {
    const body = await ws(`/recording/${encodeURIComponent(mbid)}`, {
      inc: 'artist-credits+releases+release-groups+media+isrcs',
    });
    return toTrack(body);
  });
}

export async function searchArtists(name, { limit = 10 } = {}) {
  return cached(`mb:artist-search:${limit}:${name}`, 'musicbrainz', async () => {
    const body = await ws('/artist', { query: luceneTerm('artist', name), limit });
    return (body?.artists || []).map((artist) => ({
      provider: 'musicbrainz',
      mbid: artist.id,
      name: artist.name,
      sortName: artist['sort-name'] || null,
      disambiguation: artist.disambiguation || null,
      country: artist.country || null,
    }));
  });
}

// The shape the UI search route expects, matching the other providers so the
// route can iterate over all of them without special cases.
export async function searchAll(q, { types = 'track', limit = 20 } = {}) {
  if (types === 'artist') {
    const artists = await searchArtists(q, { limit });
    return { tracks: [], albums: [], artists };
  }
  if (types === 'album') {
    return cached(`mb:release-search:${limit}:${q}`, 'musicbrainz', async () => {
      const body = await ws('/release', { query: luceneTerm('release', q), limit });
      return {
        tracks: [],
        albums: (body?.releases || []).map(toAlbumFromRelease).filter(Boolean),
        artists: [],
      };
    });
  }
  const tracks = await searchTracks({ title: q, limit });
  return { tracks, albums: [], artists: [] };
}

export async function getReleaseTracks(mbid) {
  return cached(`mb:release-tracks:${mbid}`, 'musicbrainz', async () => {
    const release = await ws(`/release/${encodeURIComponent(mbid)}`, {
      inc: 'artist-credits+recordings+release-groups+media+isrcs',
    });
    const album = toAlbumFromRelease(release);

    const tracks = [];
    for (const medium of release.media || []) {
      for (const track of medium.tracks || []) {
        const recording = track.recording;
        if (!recording) continue;
        tracks.push({
          provider: 'musicbrainz',
          mbid: recording.id,
          isrc: recording.isrcs?.[0] || null,
          title: track.title || recording.title,
          durationMs: track.length ?? recording.length ?? null,
          trackNo: Number(track.number) || track.position || null,
          discNo: medium.position ?? null,
          explicit: null,
          artists: toArtists(track['artist-credit'] || recording['artist-credit']),
          album,
          externalUrl: `https://musicbrainz.org/recording/${recording.id}`,
        });
      }
    }
    return { album, tracks };
  });
}
