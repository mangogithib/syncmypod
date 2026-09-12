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
// -- YouTube Music ----------------------------------------------------------
//
// The important difference from the video search below: **results come back as
// structured fields**, not as a title to be guessed at.
//
// A YouTube video search gives "Bebe Rexha & Faithless - New Religion (Official
// Visual)" and a channel name, and turning that into an artist and a song is
// guesswork that goes wrong on every upload that does not follow the
// convention. YouTube Music is a different index over the same catalogue, and
// it returns the artist, the album and the song as separate fields, each run
// tagged with what it is - MUSIC_PAGE_TYPE_ARTIST, MUSIC_PAGE_TYPE_ALBUM.
//
// That matters twice over. Search results show correct credits instead of a
// promo tag, and the resolver gets a real artist to match on rather than a
// fragment of a title - so far more tracks resolve, and far fewer fall through
// to being stored with a title alone.
//
// This is the approach ytmusicapi takes. That library is Python and this is
// Node, so what is ported is the method rather than the code: the same
// InnerTube endpoint, the same WEB_REMIX client, no key and no account.

const MUSIC_API = 'https://music.youtube.com/youtubei/v1/search';

// The client YouTube Music's own web app identifies as. A plain WEB client gets
// video results back instead, which is the thing being avoided.
const MUSIC_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' };

// YouTube's own "songs only" filter. Opaque because it is a base64 protobuf;
// this is the value the site itself sends. Without it the response mixes in
// albums, artists, playlists and music videos, and a music video is a different
// recording from the song - usually with an intro, and a different length.
const SONGS_ONLY = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

// Searches YouTube Music and returns tracks with real metadata.
export async function searchMusic(query, { limit = MAX_RESULTS } = {}) {
  if (!isEnabled()) return [];
  const text = String(query || '').trim();
  if (!text) return [];

  let data;
  try {
    data = await limiter(() =>
      postJson(MUSIC_API, {
        context: { client: { ...MUSIC_CLIENT, hl: 'en', gl: 'US' } },
        query: text,
        params: SONGS_ONLY,
      })
    );
  } catch {
    // A failure here is not worth surfacing: the caller falls back to the video
    // search, which is the same catalogue reached a worse way.
    return [];
  }

  const found = [];
  collectMusicItems(data, found, new Set(), limit);
  return found;
}

export function collectMusicItems(node, out = [], seen = new Set(), limit = MAX_RESULTS) {
  if (!node || typeof node !== 'object' || out.length >= limit) return out;

  if (Array.isArray(node)) {
    for (const item of node) collectMusicItems(item, out, seen, limit);
    return out;
  }

  if (node.musicResponsiveListItemRenderer) {
    const track = shapeMusicItem(node.musicResponsiveListItemRenderer);
    if (track && !seen.has(track.videoId)) {
      seen.add(track.videoId);
      out.push(track);
    }
    return out;
  }

  for (const value of Object.values(node)) collectMusicItems(value, out, seen, limit);
  return out;
}

function shapeMusicItem(item) {
  const videoId = item.playlistItemData?.videoId || watchVideoId(item);
  if (!videoId) return null;

  const columns = item.flexColumns || [];
  const title = columnText(columns[0]);
  if (!title) return null;

  // The second column is the interesting one: a list of runs where the ones
  // that matter carry a navigation endpoint saying what they are. Reading the
  // tags rather than splitting on the bullet separator is what makes this
  // reliable - an artist with a bullet in their name would break the split, and
  // the column's shape varies by result type.
  const runs = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];

  const artists = [];
  let album = null;
  let durationMs = null;

  for (const run of runs) {
    const label = String(run?.text || '').trim();
    if (!label || label === '•') continue;

    const pageType =
      run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType || '';

    if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') artists.push(label);
    else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM') album = label;
    else if (/^\d+(:\d\d)+$/.test(label)) durationMs = parseDuration(label);
  }

  // An album whose name is the song's is a single, and repeating it as an album
  // adds nothing - the resolver would score it against itself.
  if (album && album.toLowerCase() === title.toLowerCase()) album = null;

  return {
    kind: 'youtube',
    source: 'music',
    videoId,
    url: `https://music.youtube.com/watch?v=${videoId}`,
    title,
    // Several credited artists come back as separate runs, in the order
    // YouTube Music lists them, which is the order a record sleeve uses.
    artist: artists.join(', ') || null,
    artistCredit: artists.join(', ') || null,
    album,
    durationMs,
    artworkUrl: musicThumbnail(item) || thumbnailFor(videoId),
    channel: artists[0] || '',
    views: columnText(columns[2]) || null,
    // Everything here comes from YouTube's music catalogue rather than from a
    // video title, so it is worth marking as such: the UI can show it without
    // the "this is a guess" hedging a scraped title needs.
    official: true,
  };
}

function columnText(column) {
  const runs = column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
  if (!Array.isArray(runs)) return '';
  return runs.map((run) => run.text || '').join('').trim();
}

function watchVideoId(item) {
  // Some results carry the id only on the row's own tap target.
  const endpoint =
    item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId;
  return endpoint || null;
}

function musicThumbnail(item) {
  const sources =
    item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    item.thumbnail?.thumbnails ||
    [];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  // Largest available. These are square cover art rather than 16:9 video
  // stills, which is the other thing YouTube Music gets right.
  return sources[sources.length - 1]?.url || null;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'content-type': 'application/json',
      origin: 'https://music.youtube.com',
      referer: 'https://music.youtube.com/',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new ProviderError(`YouTube Music returned ${response.status}.`, {
      provider: 'youtube',
      status: 502,
      retryable: response.status >= 500,
    });
  }
  return response.json();
}

// -- The resolver's view of YouTube Music ------------------------------------
//
// Deezer, iTunes and MusicBrainz between them cover licensed commercial
// releases, which is most music and not all of it. What they miss is regional
// and recent: a Malayalam single from last month is on YouTube Music and
// nowhere else, and until this existed such a track was stored with a title and
// no artist and never synced.
//
// So YouTube Music sits at the **end** of the ladder, after the three
// catalogues have said no. That ordering is the whole design:
//
//   * It has no ISRC, so a track it resolves cannot converge with the same
//     recording found elsewhere. Letting it answer first would fragment the
//     catalogue for music the others know perfectly well.
//   * Its album field is sometimes the single's own name, which is true but
//     less useful than a real release.
//
// What it does have is a real artist, a real album name and real cover art,
// taken from Google's music catalogue rather than from a video title. That is
// the difference between this and the video search below, and it is why this
// one is allowed to resolve a track at all.
export async function findByIsrc() {
  // YouTube Music does not expose ISRCs. Answering "no" quickly keeps it out of
  // the resolver's first tier without a request.
  return null;
}

// The ladder's shape: same arguments, same returned records, as every other
// provider.
export async function searchTracksForResolver({ title, artist, album, limit = 10 }) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return [];

  const found = await searchMusic(query, { limit });
  return found.map((entry) => toResolverTrack(entry, album)).filter(Boolean);
}

function toResolverTrack(entry, queriedAlbum) {
  if (!entry?.title) return null;

  const names = String(entry.artist || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  const artists = names.map((name, index) => ({
    provider: 'youtube-music',
    name,
    position: index,
    role: index === 0 ? 'primary' : 'featured',
  }));

  const albumName = entry.album || queriedAlbum || null;

  return {
    provider: 'youtube-music',
    // No identifier of any kind, deliberately. A YouTube video id is not an
    // identity for a recording - the same song is uploaded many times - so
    // storing one would create a false sense of having identified something.
    isrc: null,
    title: entry.title,
    durationMs: entry.durationMs ?? null,
    trackNo: null,
    discNo: null,
    explicit: null,
    artists,
    album: albumName
      ? {
          provider: 'youtube-music',
          name: albumName,
          // Square cover art rather than a 16:9 video still, which is the other
          // thing YouTube Music gets right.
          artworkUrl: entry.artworkUrl || null,
          artists: [artists[0]],
        }
      : null,
    externalUrl: entry.url || null,
  };
}

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

// -- Playlists --------------------------------------------------------------

// A playlist reference, however the user pasted it.
//
// People paste the whole address from the URL bar, which carries a video id and
// a position alongside the list id, or they paste just the id. Both work.
export function parsePlaylistRef(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  // A bare id. YouTube's own are PL/UU/OL/RD prefixed; accepting anything of
  // the right shape avoids arguing with a prefix that has not been seen yet.
  if (/^[A-Za-z0-9_-]{12,64}$/.test(text) && !text.includes('/')) return text;

  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;
    const list = url.searchParams.get('list');
    return list && /^[A-Za-z0-9_-]{12,64}$/.test(list) ? list : null;
  } catch {
    return null;
  }
}

// Everything in a public playlist, in its own order.
//
// The page renders roughly a hundred entries and fetches the rest as you
// scroll. Those continuations are followed, because a playlist worth importing
// is usually longer than a hundred - but not indefinitely: a channel's "all
// uploads" list runs to thousands and nobody meant to import that in one click.
export async function getPlaylist(playlistId, { maxTracks = 500 } = {}) {
  if (!isEnabled()) {
    throw new ProviderError('YouTube is turned off in Settings.', {
      provider: 'youtube',
      status: 503,
    });
  }

  const html = await limiter(() =>
    fetchPage(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`)
  );
  const data = extractInitialData(html);
  if (!data) {
    throw new ProviderError(
      'That playlist could not be read. It may be private, or YouTube changed the page.',
      { provider: 'youtube', status: 502 }
    );
  }

  const tracks = [];
  const seen = new Set();
  collectPlaylistVideos(data, tracks, seen, maxTracks);

  // Paging uses the internal API the page itself calls, because the token is
  // only meaningful to that endpoint. Its credentials come out of the page just
  // fetched, so nothing is hardcoded and nothing needs an account.
  let token = continuationToken(data);
  const session = innertubeSession(html);
  let pages = 0;
  while (token && session && tracks.length < maxTracks && pages < 20) {
    pages++;
    let next;
    try {
      next = await limiter(() => innertubeBrowse(session, { continuation: token }));
    } catch {
      // A page of a long playlist failing is not worth losing the hundred
      // already in hand - the import proceeds with what was read.
      break;
    }
    const before = tracks.length;
    collectPlaylistVideos(next, tracks, seen, maxTracks);
    token = continuationToken(next);
    if (tracks.length === before) break; // no progress: stop rather than spin
  }

  if (tracks.length === 0) {
    throw new ProviderError(
      'That playlist has no videos this could read. Private playlists are not visible here.',
      { provider: 'youtube', status: 404 }
    );
  }

  return {
    id: playlistId,
    name: playlistTitle(data) || 'YouTube playlist',
    tracks: tracks.slice(0, maxTracks),
    truncated: Boolean(token) && tracks.length >= maxTracks,
  };
}

// Walks a response and appends every video entry it finds, in page order.
//
// Two shapes, because YouTube is midway through replacing one with the other.
// `playlistVideoRenderer` is the long-standing form; `lockupViewModel` is the
// newer component the playlist page currently serves. Reading both means the
// import keeps working whichever is returned, including during the changeover
// when one response can carry a mixture.
export function collectPlaylistVideos(node, out = [], seen = new Set(), limit = 500) {
  if (!node || typeof node !== 'object' || out.length >= limit) return out;

  if (Array.isArray(node)) {
    for (const item of node) collectPlaylistVideos(item, out, seen, limit);
    return out;
  }

  const entry = node.playlistVideoRenderer
    ? shapeVideo(node.playlistVideoRenderer)
    : node.lockupViewModel
      ? shapeLockup(node.lockupViewModel)
      : null;

  if (entry && !seen.has(entry.videoId)) {
    seen.add(entry.videoId);
    out.push(entry);
    return out; // nothing useful is nested inside an entry
  }

  for (const value of Object.values(node)) collectPlaylistVideos(value, out, seen, limit);
  return out;
}

// The newer playlist row. The same five facts, in different places.
function shapeLockup(lockup) {
  const videoId = lockup.contentId;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  // Playlists can hold other playlists and channel cards. Only videos.
  if (lockup.contentType && !/VIDEO/.test(lockup.contentType)) return null;

  const meta = lockup.metadata?.lockupMetadataViewModel;
  const title = meta?.title?.content ? String(meta.title.content) : '';
  if (!title) return null;

  // The first metadata row is the channel; the rows after it are view counts
  // and ages, which are not wanted.
  const channel = String(
    meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text
      ?.content || ''
  );

  const durationMs = parseDuration(durationBadge(lockup.contentImage));
  // No length means a live stream, a premiere, or an entry that has since been
  // deleted. None of those is a song.
  if (!durationMs) return null;

  return {
    kind: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    channel,
    ...splitArtistTitle(title, channel),
    durationMs,
    artworkUrl: thumbnailFor(videoId),
    views: null,
    official: /\s-\s*topic$/i.test(channel),
  };
}

// The duration sits in a badge overlaid on the thumbnail, several wrappers
// down. Found by shape rather than by path: those wrappers are exactly the part
// of this structure that keeps being renamed.
function durationBadge(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = durationBadge(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const badge = node.thumbnailBadgeViewModel;
  if (badge?.text && /^\d+(:\d\d)+$/.test(String(badge.text).trim())) {
    return String(badge.text).trim();
  }
  for (const value of Object.values(node)) {
    const found = durationBadge(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// The token that asks for the next page of entries.
function continuationToken(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = continuationToken(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const token =
    node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    node.continuationItemViewModel?.continuationEndpoint?.continuationCommand?.token ||
    node.continuationCommand?.token;
  if (token) return String(token);

  for (const value of Object.values(node)) {
    const found = continuationToken(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function playlistTitle(data) {
  // The heading lives in a different place depending on which layout was
  // served, so this looks for the first plausible one rather than following a
  // path that changes.
  let title = null;
  const visit = (node, depth = 0) => {
    if (title || !node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const candidate =
      firstText(node.playlistHeaderRenderer?.title) ||
      node.pageHeaderViewModel?.title?.dynamicTextViewModel?.text?.content ||
      '';
    if (candidate) {
      title = String(candidate);
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(data);
  return title;
}

// --- YouTube's own internal API ---------------------------------------------
//
// Used only for paging. The credentials come out of the page already fetched,
// so this is the same request the browser makes when you scroll.

function innertubeSession(html) {
  const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html);
  const version = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html);
  return key && version ? { key: key[1], version: version[1] } : null;
}

async function innertubeBrowse(session, payload) {
  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(session.key)}`,
    {
      method: 'POST',
      headers: {
        ...HEADERS,
        'content-type': 'application/json',
        'x-youtube-client-name': '1',
        'x-youtube-client-version': session.version,
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: session.version, hl: 'en', gl: 'US' },
        },
        ...payload,
      }),
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!response.ok) {
    throw new ProviderError(`YouTube returned ${response.status}.`, {
      provider: 'youtube',
      status: 502,
      retryable: response.status >= 500,
    });
  }
  return response.json();
}

async function fetchSearchPage(query) {
  return fetchPage(`${SEARCH}?search_query=${encodeURIComponent(query)}&sp=${VIDEOS_ONLY}`);
}

async function fetchPage(url) {
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

  // A search result names its channel in ownerText; a playlist entry uses
  // shortBylineText instead. Same renderer shape otherwise, so one function
  // covers both as long as it looks in all three places.
  const channel =
    firstText(renderer.ownerText) ||
    firstText(renderer.shortBylineText) ||
    firstText(renderer.longBylineText) ||
    '';
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
