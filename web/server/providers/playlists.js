import { ProviderError } from '../lib/http.js';
import * as deezer from './deezer.js';
import * as youtube from './youtube.js';

// Reading a playlist from wherever it came from.
//
// One box, any link. The Import page used to have a separate card per source,
// which made the user classify the link before pasting it - a question they
// should not have to answer, since the address says which service it is.
//
// ── What each reader can be trusted with ────────────────────────────────────
//
// The important difference between these is not how they are fetched, it is
// what their metadata is worth:
//
//   `catalogue`  Deezer, Spotify, Apple Music. The artist and album are fields
//                in a music catalogue. If our own resolver cannot match the
//                track, keeping what they said is better than discarding it.
//   `upload`     YouTube and YouTube Music playlists, which are lists of
//                videos. The "artist" is a guess split out of a video title,
//                so it is used as a search and never stored - see the metadata
//                rule in HANDOVER.md.
//
// Spotify and Apple Music are read from the pages their own embeds use. Neither
// needs a key or an account, which keeps the property that matters: paste a
// link, get the songs. Spotify's Web API would be the tidier route and is not
// available - it refuses every call unless the account that owns the registered
// app holds Premium.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = 20_000;

export const PLATFORMS = {
  deezer: { label: 'Deezer', quality: 'catalogue' },
  spotify: { label: 'Spotify', quality: 'catalogue' },
  'apple-music': { label: 'Apple Music', quality: 'catalogue' },
  youtube: { label: 'YouTube', quality: 'upload' },
  'youtube-music': { label: 'YouTube Music', quality: 'upload' },
};

/**
 * Works out which service a pasted link belongs to.
 *
 * Returns { platform, ref } or null. The ref is that service's own playlist id,
 * normalised, so the same playlist pasted in three URL shapes is one source.
 */
export function detect(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  // The app's own URI form first: it parses as a URL with an empty hostname, so
  // the host checks below would never see it. This is what Spotify's "Copy
  // Spotify URI" puts on the clipboard.
  if (/^spotify:playlist:/i.test(text)) {
    const ref = parseSpotifyRef(text);
    return ref ? { platform: 'spotify', ref } : null;
  }

  let host = '';
  try {
    host = new URL(text.startsWith('http') ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    host = '';
  }

  if (/(^|\.)music\.youtube\.com$/.test(host)) {
    const ref = youtube.parsePlaylistRef(text);
    return ref ? { platform: 'youtube-music', ref } : null;
  }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) {
    const ref = youtube.parsePlaylistRef(text);
    return ref ? { platform: 'youtube', ref } : null;
  }
  if (/(^|\.)deezer\.com$|(^|\.)deezer\.page\.link$/.test(host)) {
    const ref = deezer.parsePlaylistRef(text);
    return ref ? { platform: 'deezer', ref } : null;
  }
  if (/(^|\.)spotify\.com$/.test(host)) {
    const ref = parseSpotifyRef(text);
    return ref ? { platform: 'spotify', ref } : null;
  }
  if (/(^|\.)music\.apple\.com$|(^|\.)itunes\.apple\.com$/.test(host)) {
    const ref = parseAppleRef(text);
    return ref ? { platform: 'apple-music', ref } : null;
  }

  // No host: a bare id. Only Deezer's is unambiguous, being all digits.
  if (!host && /^\d{5,}$/.test(text)) return { platform: 'deezer', ref: text };
  return null;
}

/** Everything in the playlist, in a shape the importer understands. */
export async function read(platform, ref, options = {}) {
  switch (platform) {
    case 'deezer':
      return readDeezer(ref);
    case 'youtube':
    case 'youtube-music':
      return readYouTube(ref, options);
    case 'spotify':
      return readSpotify(ref);
    case 'apple-music':
      return readApple(ref);
    default:
      throw new ProviderError(`No reader for ${platform}.`, { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

async function readDeezer(ref) {
  const { playlist, tracks } = await deezer.getPlaylist(ref);
  return {
    name: playlist.name,
    artworkUrl: playlist.artworkUrl || null,
    quality: 'catalogue',
    tracks: tracks.map((track) => ({
      title: track.title,
      artist: track.artists?.[0]?.name || null,
      album: track.album?.name || null,
      durationMs: track.durationMs,
      // A real track id, so the resolver hydrates rather than searching.
      deezerId: track.deezerId,
      identity: `deezer:${track.deezerId}`,
      sourceHint: null,
    })),
  };
}

async function readYouTube(ref, options) {
  const playlist = await youtube.getPlaylist(ref, options);
  return {
    name: playlist.name,
    artworkUrl: playlist.tracks[0]?.artworkUrl || null,
    quality: 'upload',
    tracks: playlist.tracks.map((entry) => ({
      title: entry.title,
      artist: entry.artist || null,
      album: null,
      durationMs: entry.durationMs,
      identity: entry.url,
      // The address to download from, which matters most for the tracks that
      // never resolve.
      sourceHint: entry.url,
    })),
  };
}

// --- Spotify ---------------------------------------------------------------

export function parseSpotifyRef(input) {
  const text = String(input || '').trim();
  // spotify:playlist:ID
  const uri = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(text);
  if (uri) return uri[1];
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    // /playlist/ID, and the localised /intl-xx/playlist/ID.
    const match = /\/playlist\/([A-Za-z0-9]+)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function readSpotify(ref) {
  // The embed rather than the main page: it is the same data, server-rendered,
  // and it is what an <iframe> on any blog already loads.
  const html = await fetchPage(`https://open.spotify.com/embed/playlist/${encodeURIComponent(ref)}`);
  const data = extractJson(html, /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!data) {
    throw new ProviderError(
      'That Spotify playlist could not be read. Private playlists are not visible here.',
      { provider: 'spotify', status: 404 }
    );
  }

  const entity = findWhere(data, (node) => Array.isArray(node.trackList) && node.trackList.length > 0);
  const entries = entity?.trackList || [];
  if (entries.length === 0) {
    throw new ProviderError('That Spotify playlist appears to be empty or private.', {
      provider: 'spotify',
      status: 404,
    });
  }

  return {
    name: entity.name || entity.title || 'Spotify playlist',
    artworkUrl: firstImage(entity),
    quality: 'catalogue',
    tracks: entries
      .filter((entry) => entry?.title)
      .map((entry) => ({
        title: entry.title,
        // "KAROL G, Judeline, rusowsky" - the credited artists, comma joined.
        artist: entry.subtitle || null,
        album: null,
        durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
        identity: entry.uri || `spotify:${entry.uid || entry.title}`,
        sourceHint: null,
      })),
  };
}

// --- Apple Music -----------------------------------------------------------

export function parseAppleRef(input) {
  try {
    const text = String(input || '').trim();
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    // /{country}/playlist/{slug}/{pl.xxxx}
    const match = /\/playlist\/[^/]+\/(pl\.[A-Za-z0-9-]+)/.exec(url.pathname);
    if (match) return `${countryOf(url.pathname)}/${match[1]}`;
    // An album link works too, and is the commoner thing to paste.
    const album = /\/album\/[^/]+\/(\d+)/.exec(url.pathname);
    return album ? `${countryOf(url.pathname)}/album/${album[1]}` : null;
  } catch {
    return null;
  }
}

function countryOf(pathname) {
  const match = /^\/([a-z]{2})\//.exec(pathname);
  return match ? match[1] : 'us';
}

async function readApple(ref) {
  const [country, ...rest] = ref.split('/');
  const tail = rest.join('/');
  const url = tail.startsWith('album/')
    ? `https://music.apple.com/${country}/album/x/${tail.slice('album/'.length)}`
    : `https://music.apple.com/${country}/playlist/x/${tail}`;

  const html = await fetchPage(url);
  const data = extractJson(
    html,
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!data) {
    throw new ProviderError('That Apple Music playlist could not be read.', {
      provider: 'apple-music',
      status: 404,
    });
  }

  // The LARGEST list of items, not the first.
  //
  // The page wraps its track list in shelves, and a shelf holding the single
  // card for the playlist itself matches the same shape - so taking the first
  // match returned one "track" called "Today's Hits" by "Apple Music Hits".
  // A playlist's tracks are always the longest such list on its own page.
  const holder = largestItemList(data);
  const entries = holder?.items || [];
  if (entries.length === 0) {
    throw new ProviderError('That Apple Music playlist appears to be empty.', {
      provider: 'apple-music',
      status: 404,
    });
  }

  return {
    // The page's own <title> is the reliable name. The node holding the tracks
    // is a shelf, and a shelf's title is "Tracks" or nothing at all.
    name: pageTitle(html) || holder.title || 'Apple Music playlist',
    artworkUrl: firstImage(holder),
    quality: 'catalogue',
    tracks: entries
      .filter((entry) => entry?.title)
      .map((entry) => ({
        title: entry.title,
        artist: entry.subtitleLinks?.[0]?.title || entry.subtitle || null,
        album: entry.tertiaryLinks?.[0]?.title || null,
        durationMs: Number.isFinite(entry.duration)
          ? entry.duration
          : Number.isFinite(entry.durationInMillis)
            ? entry.durationInMillis
            : null,
        identity: entry.id ? `apple:${entry.id}` : `apple:${entry.title}`,
        sourceHint: null,
      })),
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function fetchPage(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(`That service could not be reached: ${err.message}`, {
      status: 502,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new ProviderError(`That playlist returned ${response.status}.`, {
      status: response.status === 404 ? 404 : 502,
      retryable: response.status >= 500,
    });
  }
  return response.text();
}

function extractJson(html, pattern) {
  const match = pattern.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Finds the first node anywhere in a structure that satisfies `test`.
//
// By shape rather than by path, for the same reason the YouTube parser works
// that way: these are internal page payloads and their wrappers get renamed
// without notice, while the node that actually holds the tracks keeps its
// recognisable shape.
function findWhere(node, test, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findWhere(item, test, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (test(node)) return node;
  for (const value of Object.values(node)) {
    const found = findWhere(value, test, depth + 1);
    if (found) return found;
  }
  return null;
}

// Every node carrying an `items` array of things that look like tracks, with
// the longest winning.
function largestItemList(root) {
  let best = null;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (
      Array.isArray(node.items) &&
      node.items.length > (best?.items.length || 0) &&
      node.items.some((item) => item?.title && (item.subtitle || item.subtitleLinks))
    ) {
      best = node;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(root);
  return best;
}

// "Today's Hits - Playlist - Apple Music" -> "Today's Hits".
function pageTitle(html) {
  const match = /<title>([^<]+)<\/title>/i.exec(html);
  if (!match) return null;
  return (
    match[1]
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .split(/\s+[-\u2013]\s+/)[0]
      .trim() || null
  );
}

function firstImage(node) {
  const found = findWhere(node, (child) => typeof child.url === 'string' && /^https?:/.test(child.url) && /image|artwork|cover/i.test(JSON.stringify(Object.keys(child))));
  return found?.url || null;
}
