import { config } from '../config.js';

// Text normalisation used for matching and for deduplication keys.
//
// The job of this file is to make two spellings of the same thing collide:
// "Sigur Ros" and "Sigur Rós", "Bohemian Rhapsody (Remastered 2011)" and
// "Bohemian Rhapsody". It is used for match keys and fuzzy comparison only -
// never to rewrite what gets displayed or written to a tag, which always keeps
// the provider's own casing and punctuation.

// Trailing parenthetical noise that describes the recording rather than
// identifying the song. Deliberately conservative: "(Remix)" and "(Live)" are
// NOT here, because a remix genuinely is a different track and collapsing it
// would silently replace one with the other.
const DECORATIONS = [
  /\s*[([]\s*(?:official\s*)?(?:music\s*)?video\s*[)\]]\s*/gi,
  /\s*[([]\s*official\s*(?:audio|lyric[s]?\s*video|visualizer)\s*[)\]]\s*/gi,
  /\s*[([]\s*(?:hd|4k|full\s*song|full\s*video|lyrics?)\s*[)\]]\s*/gi,
  /\s*[([]\s*from\s+["']?[^)\]]*["']?\s*[)\]]\s*/gi,
  /\s*[([]\s*remaster(?:ed)?(?:\s*\d{4})?\s*[)\]]\s*/gi,
  /\s*[([]\s*\d{4}\s*remaster(?:ed)?\s*[)\]]\s*/gi,
  /\s*-\s*(?:official\s*)?(?:music\s*)?video\s*$/gi,
  /\s*-\s*topic\s*$/gi,
];

export function stripDecorations(text) {
  let out = String(text || '');
  for (const pattern of DECORATIONS) out = out.replace(pattern, ' ');
  return out.trim();
}

// Aggressive fold for comparison: lowercase, accents removed, punctuation
// dropped, whitespace collapsed. Never shown to a user.
export function foldForMatch(text) {
  return String(text || '')
    .normalize('NFKD')
    // Combining marks, i.e. the accents NFKD just split off. The Unicode
    // property escape rather than a literal codepoint range, so this file stays
    // pure ASCII and survives any editor or transfer.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Identity key for the catalogue.
//
// The order matters, and it is not simply "whichever provider answered".
//
// ISRC FIRST, for tracks. It is the only identifier that survives crossing
// between services, so keying on it is what stops the same recording found via
// Deezer and later via iTunes from becoming two catalogue rows - and therefore
// two entries on the iPod. A provider id is only used when there is no ISRC.
//
// Provider ids are then tried in a FIXED order rather than "whichever the
// calling provider supplied", so a record carrying two ids always produces the
// same key regardless of which provider resolved it. Order without that
// guarantee would defeat the point.
//
// The name fallback is a last resort. It cannot distinguish two different songs
// with the same title, which is why callers pass `extra` (an artist, or an
// artist plus album) to qualify it.
//
// Albums and artists have no ISRC equivalent, so cross-provider duplicates
// remain possible for them where names differ in punctuation. The name fallback
// catches most of it; the rest is a known, tolerable imperfection.
export function matchKey({ isrc, deezerId, itunesId, mbid, name, extra }) {
  const cleanIsrc = String(isrc || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (cleanIsrc.length === 12) return `isrc:${cleanIsrc}`;

  if (deezerId) return `dz:${deezerId}`;
  if (itunesId) return `it:${itunesId}`;
  if (mbid) return `mb:${mbid}`;

  const folded = foldForMatch(stripDecorations(name));
  return `n:${[folded, extra && foldForMatch(extra)].filter(Boolean).join('|')}`;
}

// How multiple artists become the single string written to the iPod tag.
//
// The concept flags this as an open question, so it is one function and one
// setting rather than string concatenation scattered through the codebase. The
// structured list stays in track_artists either way, so changing the convention
// later is a re-render, not a re-import.
export function joinArtists(artists) {
  const names = (artists || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((artist) => artist.name)
    .filter(Boolean);
  return [...new Set(names)].join(config.artistJoin);
}

// Deezer and iTunes give a full release date; MusicBrainz gives a partial
// date string. Both are kept verbatim, with just the year pulled out for
// sorting and for the iPod year tag.
export function yearFromDate(date) {
  const match = /^(\d{4})/.exec(String(date || ''));
  return match ? Number(match[1]) : null;
}

// Similarity in 0..1, used to decide whether a search result is actually the
// track that was asked for. Token-set overlap rather than edit distance: it is
// robust to word order and to one side carrying extra words, which is exactly
// how "Karma Police" and "Karma Police - Radio Edit" differ.
export function similarity(a, b) {
  const left = new Set(foldForMatch(a).split(' ').filter(Boolean));
  const right = new Set(foldForMatch(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  // Dice coefficient. Symmetric, and less punishing of extra words than
  // Jaccard, which matters because provider titles are often more verbose.
  return (2 * shared) / (left.size + right.size);
}

// Scores a candidate against what was searched for. Duration is the strongest
// signal after the ISRC: two different songs sharing a title is common, two
// different songs sharing a title and a runtime to within two seconds is not.
export function scoreCandidate(query, candidate) {
  // Decorations are stripped from BOTH sides, which is easy to get wrong and
  // consequential when it is.
  //
  // Stripping only the query means a provider's own decorated title is compared
  // verbatim, and its extra words count against it. A soundtrack entry titled
  // 'Kesariya (From "Brahmastra")' then scores 0.5 against the query "Kesariya",
  // while an unrelated single simply titled "Kesariya" scores 1.0 - so the
  // generic single wins and the film version, which is what was actually asked
  // for, loses on having a more precise title.
  const titleScore = similarity(
    stripDecorations(query.title),
    stripDecorations(candidate.title)
  );

  let artistScore = 0;
  if (query.artist && candidate.artistCredit) {
    artistScore = similarity(query.artist, candidate.artistCredit);
  }

  let durationScore = 0;
  if (query.durationMs && candidate.durationMs) {
    const deltaSeconds = Math.abs(query.durationMs - candidate.durationMs) / 1000;
    if (deltaSeconds <= 2) durationScore = 1;
    else if (deltaSeconds <= 5) durationScore = 0.7;
    else if (deltaSeconds <= 15) durationScore = 0.3;
    // Beyond 15 seconds apart it counts for nothing rather than counting
    // against, because plenty of legitimate matches differ by a long outro.
  }

  const albumScore =
    query.album && candidate.albumName
      ? similarity(stripDecorations(query.album), stripDecorations(candidate.albumName))
      : 0;

  // Weights: the title carries most of it, the artist confirms it, duration and
  // album break ties. Tuned so that a right-title/right-artist match clears the
  // acceptance threshold even with no duration or album to check against.
  return (
    titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.12 + albumScore * 0.08
  );
}

// ---------------------------------------------------------------------------
// Titles that came from an upload rather than a catalogue
// ---------------------------------------------------------------------------

// Strips what an uploader added and the song is not called.
//
// Used before asking YouTube Music about a title, because it indexes songs
// rather than uploads: "(Official Video)" only ever hurts the match.
export function cleanUploadTitle(title) {
  return String(title || '')
    // Everything after the first pipe is credits on a South Asian upload.
    .split('|')[0]
    // Bracketed descriptors: (Official Video), [Lyric Video], (4K Remaster).
    .replace(
      /[([{]\s*(?:official|full|hd|4k|lyrics?|lyrical|audio|video|visuali[sz]er|music\s*video|mv|remaster(?:ed)?|color\s*coded|eng\s*sub)[^)\]}]*[)\]}]/gi,
      ' '
    )
    // Trailing bare descriptors with no brackets at all.
    .replace(/\s*[-–—]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visuali[sz]er)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// How alike two titles are, 0 to 1, by shared words.
//
// Word overlap rather than edit distance, because the failure being guarded
// against is a search answering with a different song entirely, and that shows
// up as having almost no words in common. Edit distance would call "Kesariya"
// and "Kesariya (From Brahmastra)" distant when they are the same song.
export function titleOverlap(a, b) {
  const words = (text) =>
    new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );

  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  // Against the shorter side, so a title that is the other plus a suffix still
  // scores 1 - which is the common case here.
  return shared / Math.min(left.size, right.size);
}

// Words an uploader adds that are not part of what a song is called.
//
// Used when deciding whether a catalogue answer accounts for a scruffy upload
// title: "Oru Nokku Kaanuvaan Lyrical Video Song" is fully explained by a
// catalogue entry called "Oru Nokku Kaanuvaan", because the three words left
// over are all in here.
const UPLOAD_NOISE = new Set(
  (
    'official video audio lyric lyrics lyrical song songs full hd 4k uhd ' +
    'visualizer visualiser mv remaster remastered version ver cover mashup ' +
    'reprise live studio session teaser trailer promo exclusive new latest ' +
    'x vs feat ft featuring with and the a an of from movie film ost ' +
    'soundtrack presents presenting records music entertainment original ' +
    'motion picture track'
  ).split(' ')
);

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function significantWords(text) {
  return wordsOf(text).filter((word) => !UPLOAD_NOISE.has(word) && word.length > 1);
}

/**
 * Does `answer` (a catalogue title plus its artists) account for everything in
 * a scruffy upload `title`?
 *
 * This is the check that `titleOverlap` alone cannot make. Overlap measured
 * against the shorter side gives "just us" a perfect score against
 * "JUST US - AASHIR WAJAHAT | KOMAL MEER", because both its words are present -
 * and the answer was a different song by Gabriela Bee. What gives it away is
 * the other direction: the upload title carries "aashir" and "wajahat", and the
 * answer explains neither.
 *
 * So every significant word in the upload title has to turn up somewhere in the
 * answer. Uploader noise is ignored, which is what lets a real match through.
 */
export function answerExplains(title, answerTitle, answerArtists = []) {
  const claimed = new Set([
    ...wordsOf(answerTitle),
    ...wordsOf(Array.isArray(answerArtists) ? answerArtists.join(' ') : answerArtists),
  ]);

  const unexplained = significantWords(title).filter((word) => !claimed.has(word));
  return { ok: unexplained.length === 0, unexplained };
}
