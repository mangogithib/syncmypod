import { createRateLimiter, ProviderError } from '../lib/http.js';
import { providerToggle } from '../services/app-settings.js';

// YouTube search — the fallback for music the commercial catalogues do not have.
//
// Deezer, iTunes and MusicBrainz between them cover licensed commercial
// releases, which is most music and not all of it. Regional releases, small
// labels, anything that only ever went up on YouTube: none of it is findable
// through those three, so a library cannot contain it at all. This exists so
// that a track which is genuinely only on YouTube can still be added.
//
// **This is deliberately not in the resolver's provider ladder.** It is a
// separate endpoint the user asks for by name, for three reasons. YouTube
// metadata is a video title and a channel name, which is exactly the low-quality
// source this whole project exists to avoid trusting. Its results are ranked by
// engagement rather than by being the right recording, so a lyric video or a
// remix routinely outranks the original. And the other three answer within a
// hundred milliseconds, so falling through to a scraped HTML page on every
// search would make the common case slower for the uncommon benefit.
//
// A result picked here is added by the ordinary route, which still runs the
// resolver on its title and artist. So a YouTube-found track that *does* exist
// on Deezer comes out properly resolved, with the YouTube URL kept as the
// source hint; one that does not comes out unresolved and waits for the user to
// correct it. Either way the metadata written to the iPod is never the video
// title.
//
// ── On the parsing ──────────────────────────────────────────────────────────
//
// There is no free official search API. The Data API v3 needs a Google Cloud
// project and a key, and spends 100 of its 10,000 daily quota units per search
// — about 100 searches a day. The alternative is what every client including
// yt-dlp does: request the ordinary search page and read the JSON that YouTube
// embeds in it.
//
// That was measured from the deployment host rather than assumed, because
// datacentre IPs are treated more harshly than residential ones: it returns a
// full result set in about half a second, so no key is needed and nobody has to
// set one up.
//
// The cost is that YouTube can change the page and this stops working. That is
// survivable by design — the button returns nothing and the rest of the search
// is untouched — but it is why the parser walks the JSON looking for known
// shapes rather than following a fixed path into it.

const SEARCH = 'https://www.youtube.com/results';

// YouTube's own filter for "videos only", which drops channels and playlists
// from the results. Opaque because it is a base64 protobuf; this is the value
// the site itself uses.
const VIDEOS_ONLY = 'EgIQAQ%3D%3D';

// Pretending to be a browser, because that is what the endpoint being used is
// for. A server-shaped request gets a different, unparseable page.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  // Skips the EU consent interstitial, which otherwise replaces the results
  // with a cookie wall and no ytInitialData at all.
  Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000',
};

// One search at a time, spaced out. There is no published rate limit to honour,
// so this is about not looking like something worth blocking.
const limiter = createRateLimiter(400);

const MAX_RESULTS = 20;

// A page is about a megabyte of JavaScript. Anything much larger is not the
// page we asked for, and parsing it would be a waste of memory and time.
const MAX_BYTES = 6 * 1024 * 1024;

// Words that describe the upload rather than name the song. An uploader writing
// "Kesariya - Lyric Video" means the song is Kesariya, so splitting on the
// hyphen and taking the right-hand side gets it exactly backwards - and a
// library full of tracks called "Lyric Video" is the result. Seen on a real
// search before this existed.
const DESCRIPTOR =
  /^(official\s+)?(lyric(al)?|music|audio|video|visuali[sz]er|promo|teaser|trailer|full|hd|4k|song|track|cover\s*art)(\s+(video|song|audio|version|track))*$/i;

export function isEnabled() {
  return providerToggle('youtube');
}

// Searches YouTube and returns tracks in the same shape the other providers use,
// so the UI does not need a second renderer.
export async function searchTracks(query, { limit = MAX_RESULTS } = {}) {
  if (!isEnabled()) {
    throw new ProviderError('YouTube search is turned off in Settings.', {
      provider: 'youtube',
      status: 503,
    });
  }
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return [];

  const html = await limiter(() => fetchSearchPage(trimmed));
  const data = extractInitialData(html);
  if (!data) {
    // Not an error the user can act on, and not worth failing their search
    // over: the page came back but is not the shape expected, which means
    // YouTube changed something.
    throw new ProviderError(
      'YouTube returned a page this could not read. The search layout may have changed.',
      { provider: 'youtube', status: 502, retryable: false }
    );
  }

  return collectVideos(data, limit);
}

async function fetchSearchPage(query) {
  const url = `${SEARCH}?search_query=${encodeURIComponent(query)}&sp=${VIDEOS_ONLY}`;

  let response;
  try {
    response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ProviderError(`YouTube could not be reached: ${err.message}`, {
      provider: 'youtube',
      status: 502,
      retryable: true,
    });
  }

  if (!response.ok) {
    throw new ProviderError(`YouTube returned ${response.status}.`, {
      provider: 'youtube',
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const text = await response.text();
  if (text.length > MAX_BYTES) {
    throw new ProviderError('YouTube returned an unexpectedly large page.', {
      provider: 'youtube',
      status: 502,
    });
  }
  return text;
}

// Pulls the embedded state object out of the page.
//
// Brace counting rather than a regular expression: the object contains strings
// holding braces, so matching to the first `};` finds the wrong end of it on
// some pages and silently truncates the JSON.
export function extractInitialData(html) {
  const marker = 'ytInitialData';
  let cursor = html.indexOf(marker);

  while (cursor !== -1) {
    const start = html.indexOf('{', cursor);
    if (start === -1) return null;

    const json = readJsonObject(html, start);
    if (json) {
      try {
        return JSON.parse(json);
      } catch {
        // Keep looking. The first `ytInitialData` on the page is sometimes a
        // declaration rather than the assignment carrying the results.
      }
    }
    cursor = html.indexOf(marker, cursor + marker.length);
  }
  return null;
}

// Reads one balanced JSON object starting at `start`, respecting strings and
// escapes so that a brace inside a video title does not end it early.
function readJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

// Walks the state object collecting video entries.
//
// A search, or "did you mean", or a shelf of related content all nest results
// at different depths, and the layout changes without notice. Walking for a
// known key is the shape of parsing that survives that; following a fixed path
// is the shape that breaks every few months.
export function collectVideos(data, limit = MAX_RESULTS) {
  const found = [];
  const seen = new Set();

  const visit = (node) => {
    if (!node || typeof node !== 'object' || found.length >= limit) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const renderer = node.videoRenderer;
    if (renderer?.videoId && !seen.has(renderer.videoId)) {
      const track = shapeVideo(renderer);
      if (track) {
        seen.add(renderer.videoId);
        found.push(track);
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(data);
  return found;
}

function shapeVideo(renderer) {
  const title = firstText(renderer.title);
  if (!title) return null;

  const channel =
    firstText(renderer.ownerText) || firstText(renderer.longBylineText) || '';
  const durationMs = parseDuration(
    renderer.lengthText?.simpleText || firstText(renderer.lengthText)
  );

  // A live stream has no length, and neither has anything else that is not a
  // finished video. None of it is a song.
  if (!durationMs) return null;

  return {
    kind: 'youtube',
    videoId: renderer.videoId,
    url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
    title,
    channel,
    // Split out of "Artist - Title" where the uploader used that convention,
    // which most music uploads do. A guess, clearly labelled as one in the UI,
    // and the resolver gets the final say anyway.
    ...splitArtistTitle(title, channel),
    durationMs,
    artworkUrl: thumbnailFor(renderer.videoId, renderer.thumbnail),
    views: firstText(renderer.shortViewCountText) || null,
    // Strictly "- Topic": YouTube's auto-generated channel carrying the label's
    // own audio, which is the one signal that a result is the real recording.
    //
    // Deliberately not ownerBadges. That marks a *verified* channel, and
    // verified re-upload channels are abundant - a test search returned
    // "7clouds Latin" badged alongside the artist's own upload, which would
    // have presented a re-cut as authoritative.
    official: /\s-\s*topic$/i.test(channel),
  };
}

// "Artist - Title" is a convention, not a rule, so this is conservative: it
// splits only on a spaced hyphen and only when both halves look substantial.
// Everything else keeps the whole title and credits the channel.
export function splitArtistTitle(title, channel) {
  // Pipes first. "Song | Lyric Video | Film | Actor | Composer" is the standard
  // shape for South Asian music uploads, and everything after the first pipe is
  // credits rather than the song. Found on a real search, where the untrimmed
  // title made the track name eight fields long.
  const untilPipe = title.split('|')[0].trim() || title.trim();

  // Then a trailing "(Official Video)" and the like.
  const cleaned = untilPipe.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);

  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const rest = parts.slice(1).join(' - ').trim();
    // Only a split where the right-hand side is plausibly a song name. When it
    // just describes the upload, the left-hand side was the song all along.
    if (
      artist.length >= 2 &&
      rest.length >= 2 &&
      artist.length <= 120 &&
      !DESCRIPTOR.test(rest)
    ) {
      return { artist, trackTitle: rest };
    }
    if (DESCRIPTOR.test(rest)) {
      return { artist: creditFromChannel(channel), trackTitle: artist };
    }
  }

  return { artist: creditFromChannel(channel), trackTitle: cleaned || title };
}

// A "- Topic" channel is the artist's name with a suffix, so it is a better
// credit than the channel name verbatim.
function creditFromChannel(channel) {
  return String(channel || '').replace(/\s*-\s*topic$/i, '').trim();
}

function parseDuration(text) {
  if (!text) return null;
  const parts = String(text)
    .trim()
    .split(':')
    .map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;

  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  // An hour-plus result is a mix, a full album or a compilation, never the
  // single track that was asked for.
  if (seconds <= 0 || seconds > 3600) return null;
  return seconds * 1000;
}

// Built from the video id rather than taken from the page.
//
// These are drawn into a 36px square, and the search page usually offers only
// one size - a 720p still. Taking it meant twenty 720p JPEGs per search, several
// megabytes to draw a row of thumbnails, paid for by whoever is on a phone.
//
// Every video has a fixed set of derived thumbnails at predictable addresses, so
// the right size can simply be asked for. mqdefault is 320x180: comfortably
// sharp at 36px on a high-density screen, and about a twentieth of the bytes.
function thumbnailFor(videoId, thumbnail) {
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  // Only reachable if YouTube ever returns a result without an id, which would
  // already have been filtered out above. Cheap to keep honest.
  const options = (thumbnail?.thumbnails || []).filter((entry) => entry?.url);
  return options.length > 0 ? options[0].url : null;
}

function firstText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (field.simpleText) return String(field.simpleText);
  const runs = field.runs;
  if (Array.isArray(runs) && runs.length > 0) {
    return runs.map((run) => run.text || '').join('');
  }
  return '';
}
