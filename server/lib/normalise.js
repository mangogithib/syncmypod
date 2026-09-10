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

// Identity key for the catalogue. Provider ids win when present because they are
// authoritative; the name fallback is a last resort that at least prevents the
// same hand-typed artist appearing five times.
export function matchKey({ spotifyId, mbid, name, extra }) {
  if (spotifyId) return `sp:${spotifyId}`;
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

// Spotify gives release_date with a precision flag; MusicBrainz gives a partial
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
  const titleScore = similarity(stripDecorations(query.title), candidate.title);

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
      ? similarity(query.album, candidate.albumName)
      : 0;

  // Weights: the title carries most of it, the artist confirms it, duration and
  // album break ties. Tuned so that a right-title/right-artist match clears the
  // acceptance threshold even with no duration or album to check against.
  return (
    titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.12 + albumScore * 0.08
  );
}
