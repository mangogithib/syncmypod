import { transaction } from '../db/pool.js';
import { joinArtists, matchKey, scoreCandidate, stripDecorations } from '../lib/normalise.js';
import { expandCredit } from './artist-split.js';
import * as deezer from '../providers/deezer.js';
import * as itunes from '../providers/itunes.js';
import * as musicbrainz from '../providers/musicbrainz.js';

// Metadata resolution.
//
// The rule from the concept: never trust a download source's own title or
// description. Whatever a track claims to be, it is re-resolved against a real
// catalogue before anything is written to the iPod.
//
// Three providers are consulted in a fixed order - see PROVIDERS below - and any
// that is unconfigured or switched off is skipped, so the chain degrades instead
// of breaking.
//
// Resolution has three tiers, strongest first:
//
//   1. ISRC lookup. An exact identifier for a specific recording. No scoring
//      needed - a hit is definitionally the right track.
//   2. Structured search (title + artist + album) with candidate scoring, so a
//      near-miss is rejected rather than silently accepted.
//   3. Loose search on the cleaned-up title alone, for the case where the
//      source metadata was so poor that the "artist" was part of the title.
//
// Anything that clears ACCEPT_SCORE is stored as `resolved`. Anything below it
// is stored as `unresolved` with the best candidate remembered, so the UI can
// offer it as a suggestion for a human to confirm rather than guessing.

// Tuned against the weighting in scoreCandidate: a correct title plus a correct
// artist scores ~0.8, a right title with a wrong artist scores ~0.5. Sitting the
// bar at 0.62 accepts the former and rejects the latter.
const ACCEPT_SCORE = 0.62;
// Below this a candidate is not even worth showing as a suggestion.
const SUGGEST_SCORE = 0.35;

// Resolves one track description into a canonical record.
//
// `input` is whatever is known: { title, artist, album, isrc, durationMs,
// deezerId, itunesId, mbid }. Nothing is required except something to search on.
export async function resolveTrack(input, { preferProvider } = {}) {
  const order = providerOrder(preferProvider);
  const attempts = [];

  // --- Direct id lookups ---------------------------------------------------
  // When the caller already knows a provider id - anything coming from a search
  // result does - there is nothing to search for.
  if (input.deezerId && deezer.isEnabled()) {
    const track = await safely(
      () => deezer.hydrate({ deezerId: input.deezerId, needsHydration: true }),
      attempts,
      'deezer:id'
    );
    if (track?.title) return accepted(track, 'deezer', 1, attempts);
  }
  if (input.itunesId && itunes.isEnabled()) {
    const track = await safely(
      () => itunes.searchTracks({ title: input.title, artist: input.artist, limit: 5 }),
      attempts,
      'itunes:id'
    );
    // iTunes has no lookup-by-track-id that returns a song record directly, so
    // the id is matched against a search rather than fetched. Falls through to
    // the normal search tiers when it does not appear.
    const match = (track || []).find((entry) => entry.itunesId === String(input.itunesId));
    if (match) return accepted(match, 'itunes', 1, attempts);
  }
  if (input.mbid && musicbrainz.isEnabled()) {
    const track = await safely(() => musicbrainz.getRecording(input.mbid), attempts, 'musicbrainz:id');
    if (track) return accepted(track, 'musicbrainz', 1, attempts);
  }

  // --- Tier 1: ISRC --------------------------------------------------------
  if (input.isrc) {
    for (const provider of order) {
      if (!provider.module.isEnabled()) continue;
      const track = await safely(
        () => provider.module.findByIsrc(input.isrc),
        attempts,
        `${provider.name}:isrc`
      );
      if (track) return accepted(track, provider.name, 1, attempts);
    }
  }

  if (!input.title) {
    return unresolved(attempts, 'Nothing to search on: no title, ISRC or provider id.');
  }

  // --- Tier 2: structured search ------------------------------------------
  const cleanTitle = stripDecorations(input.title);
  let best = null;

  for (const provider of order) {
    if (!provider.module.isEnabled()) continue;

    const candidates = await safely(
      () =>
        provider.module.searchTracks({
          title: cleanTitle,
          artist: input.artist,
          album: input.album,
          limit: 10,
        }),
      attempts,
      `${provider.name}:search`
    );

    const scored = scoreAll(candidates || [], { ...input, title: cleanTitle });
    if (scored && (!best || scored.score > best.score)) {
      best = { ...scored, provider: provider.name };
    }
    // A confident hit from the preferred provider ends the search: querying
    // MusicBrainz as well would cost a second per track for no gain.
    if (best && best.score >= ACCEPT_SCORE) {
      return accepted(best.candidate, best.provider, best.score, attempts);
    }
  }

  // --- Tier 3: loose title-only search ------------------------------------
  // For the "video title as metadata" case, where the artist field was junk or
  // the artist name was embedded in the title.
  if (!best || best.score < ACCEPT_SCORE) {
    const loose = looseQuery(input);
    if (loose && loose !== cleanTitle) {
      for (const provider of order) {
        if (!provider.module.isEnabled()) continue;
        const candidates = await safely(
          () => provider.module.searchTracks({ title: loose, limit: 10 }),
          attempts,
          `${provider.name}:loose`
        );
        const scored = scoreAll(candidates || [], { ...input, title: loose });
        if (scored && (!best || scored.score > best.score)) {
          best = { ...scored, provider: provider.name };
        }
        if (best && best.score >= ACCEPT_SCORE) {
          return accepted(best.candidate, best.provider, best.score, attempts);
        }
      }
    }
  }

  if (best && best.score >= SUGGEST_SCORE) {
    return {
      state: 'unresolved',
      score: best.score,
      // Kept so the UI can say "did you mean X?" rather than just failing.
      suggestion: best.candidate,
      suggestionProvider: best.provider,
      attempts,
      reason: `Best match scored ${best.score.toFixed(2)}, below the ${ACCEPT_SCORE} threshold.`,
    };
  }

  return unresolved(attempts, 'No provider returned a plausible match.');
}

// The order providers are consulted in, best first.
//
// The ranking is by how much STRUCTURE a provider returns, not by catalogue
// size, because structure is the thing this whole design exists to protect:
//
//   deezer      ordered contributors plus an ISRC from /track. The only one of
//               the three that returns real artist structure, so it leads.
//   itunes      rich - track numbers, year, genre, strong coverage of film and
//               regional catalogue - but a single joined artist string that
//               cannot be safely split (see the note in providers/itunes.js).
//               Earns its place as a fallback despite losing that structure.
//   musicbrainz weakest: no popularity signal, so a title-only search cannot
//               distinguish an original from a cover, and every live take is
//               its own recording.
//
// None of them needs an account or a key, which is deliberate. Spotify used to
// lead this list and was removed: it now refuses all Web API access unless the
// account owning the registered app holds a Premium subscription, which made it
// unusable here whether or not the credentials were right.
//
// A provider that is off or unconfigured is skipped by the caller, so the list
// degrades rather than breaking.
const PROVIDERS = [
  { name: 'deezer', module: deezer },
  { name: 'itunes', module: itunes },
  { name: 'musicbrainz', module: musicbrainz },
];

function providerOrder(preferProvider) {
  if (!preferProvider) return PROVIDERS;
  // A named preference moves that provider to the front and keeps the rest in
  // their usual order, rather than reducing the list to just that one - a
  // preference is a hint about where to look first, not an instruction to give
  // up if it misses.
  const preferred = PROVIDERS.filter((entry) => entry.name === preferProvider);
  if (preferred.length === 0) return PROVIDERS;
  return [...preferred, ...PROVIDERS.filter((entry) => entry.name !== preferProvider)];
}

// Some providers return a light record from search and need a second request for
// the parts that matter to a tag - Deezer's ISRC, track number and full artist
// credit. Doing that for every candidate would multiply the request count; doing
// it for the winner costs one extra request per resolved track.
async function hydrate(candidate, providerName) {
  const entry = PROVIDERS.find((provider) => provider.name === providerName);
  if (!entry?.module.hydrate) return candidate;
  try {
    return (await entry.module.hydrate(candidate)) || candidate;
  } catch (err) {
    // The light record is still usable; losing the ISRC is better than losing
    // the track.
    console.error(`[resolver] ${providerName} hydrate failed:`, err.message);
    return candidate;
  }
}

function scoreAll(candidates, input) {
  let best = null;
  const total = candidates.length;

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate) continue;
    const similarityScore = scoreCandidate(
      {
        title: input.title,
        artist: input.artist,
        album: input.album,
        durationMs: input.durationMs,
      },
      {
        title: candidate.title,
        artistCredit: joinArtists(candidate.artists),
        albumName: candidate.album?.name,
        durationMs: candidate.durationMs,
      }
    );

    // A provider may report that a candidate, while a textual match, is a poor
    // representation of the recording - a bootleg or a live take rather than
    // the studio version. Those are indistinguishable on title and artist
    // alone, so without this the first one returned simply wins.
    const penalty = candidate.qualityPenalty || 0;

    // A small bonus for appearing earlier in the provider's own results.
    //
    // Providers order by popularity, and this scorer was throwing that away.
    // It matters for exact ties, which are common: a song and its remix share a
    // title and a primary artist, so with no duration to compare they score
    // identically and the winner came down to iteration order. Ranking the more
    // popular one first is almost always what someone meant - a search for
    // "Kesariya" wants the film version, not a remix single.
    //
    // Capped at 0.02, an order of magnitude below the weakest real signal, so
    // it decides ties and never overrides evidence.
    const positionBonus = total > 1 ? 0.02 * (1 - index / (total - 1)) : 0;

    const score = Math.max(0, similarityScore - penalty + positionBonus);

    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

// Turns "Artist - Title (Official Video)" into something searchable. Download
// sources overwhelmingly use this shape, and the hyphen split is what recovers
// an artist that was never in an artist field.
function looseQuery(input) {
  const cleaned = stripDecorations(input.title);
  const dash = cleaned.split(/\s+[-–—|]\s+/);
  if (dash.length >= 2) {
    // The longer half is more likely the title; the shorter is usually the
    // artist. Not always right, but the score gate catches it when it is wrong.
    return dash.slice(1).join(' ').trim() || cleaned;
  }
  return cleaned;
}

async function safely(fn, attempts, label) {
  try {
    const result = await fn();
    attempts.push({ step: label, ok: true, found: Boolean(result) });
    return result;
  } catch (err) {
    // One provider being down, rate limited or unconfigured must not fail the
    // whole resolution - that is the entire point of having a fallback.
    attempts.push({ step: label, ok: false, error: err.message });
    return null;
  }
}

// Async because the winning candidate may need a second request to fill in the
// fields a tag actually needs. Every caller already returns this from an async
// function, so awaiting is transparent to them.
async function accepted(candidate, provider, score, attempts) {
  const track = await hydrate(candidate, provider);
  return { state: 'resolved', track, provider, score, attempts };
}

function unresolved(attempts, reason) {
  return { state: 'unresolved', attempts, reason, score: 0 };
}

// ---------------------------------------------------------------------------
// Persisting a resolved record into the catalogue
// ---------------------------------------------------------------------------

// Upserts an artist and returns its id. ON CONFLICT on match_key is what makes
// this safe to call concurrently: two imports resolving the same featured artist
// at the same time converge on one row instead of raising a unique violation.
async function upsertArtist(client, artist) {
  const key = matchKey({
    deezerId: artist.deezerId,
    itunesId: artist.itunesId,
    mbid: artist.mbid,
    name: artist.name,
  });

  const { rows } = await client.query(
    `INSERT INTO artists (match_key, name, sort_name, deezer_id, itunes_id,
                          mbid, image_url, genres)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (match_key) DO UPDATE
        SET name       = EXCLUDED.name,
            -- COALESCE the other way round for ids: once a row has learned a
            -- provider id, a later record that lacks it must not erase it. This
            -- is also how a row accumulates identities across providers.
            deezer_id  = COALESCE(artists.deezer_id, EXCLUDED.deezer_id),
            itunes_id  = COALESCE(artists.itunes_id, EXCLUDED.itunes_id),
            mbid       = COALESCE(artists.mbid, EXCLUDED.mbid),
            image_url  = COALESCE(EXCLUDED.image_url, artists.image_url),
            genres     = COALESCE(EXCLUDED.genres, artists.genres),
            sort_name  = COALESCE(EXCLUDED.sort_name, artists.sort_name),
            updated_at = now()
     RETURNING id`,
    [
      key,
      artist.name,
      artist.sortName || null,
      artist.deezerId || null,
      artist.itunesId || null,
      artist.mbid || null,
      artist.imageUrl || null,
      artist.genres || null,
    ]
  );
  return rows[0].id;
}

async function upsertAlbum(client, album) {
  if (!album?.name) return null;

  const albumArtist = album.artists?.[0];
  const albumArtistId = albumArtist ? await upsertArtist(client, albumArtist) : null;

  const key = matchKey({
    deezerId: album.deezerId,
    itunesId: album.itunesId,
    mbid: album.mbid,
    name: album.name,
    // Two different albums genuinely share a name ("Greatest Hits"), so the
    // name-only fallback key is qualified by the album artist.
    extra: albumArtist?.name,
  });

  const { rows } = await client.query(
    `INSERT INTO albums (match_key, name, album_artist_id, deezer_id,
                         itunes_id, mbid, release_date, release_year, artwork_url,
                         total_tracks, album_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (match_key) DO UPDATE
        SET name            = EXCLUDED.name,
            album_artist_id = COALESCE(EXCLUDED.album_artist_id, albums.album_artist_id),
            deezer_id       = COALESCE(albums.deezer_id, EXCLUDED.deezer_id),
            itunes_id       = COALESCE(albums.itunes_id, EXCLUDED.itunes_id),
            mbid            = COALESCE(albums.mbid, EXCLUDED.mbid),
            release_date    = COALESCE(EXCLUDED.release_date, albums.release_date),
            release_year    = COALESCE(EXCLUDED.release_year, albums.release_year),
            artwork_url     = COALESCE(EXCLUDED.artwork_url, albums.artwork_url),
            total_tracks    = COALESCE(EXCLUDED.total_tracks, albums.total_tracks),
            album_type      = COALESCE(EXCLUDED.album_type, albums.album_type),
            updated_at      = now()
     RETURNING id`,
    [
      key,
      album.name,
      albumArtistId,
      album.deezerId || null,
      album.itunesId || null,
      album.mbid || null,
      album.releaseDate || null,
      album.releaseYear || null,
      album.artworkUrl || null,
      album.totalTracks || null,
      album.albumType || null,
    ]
  );
  return rows[0].id;
}

// Writes a resolved track and everything it references. Runs in one transaction
// so a track never exists without its artists.
export async function saveResolvedTrack(resolved, { client } = {}) {
  // Before the transaction, deliberately: this may call out to Deezer, and
  // holding a database transaction open across a network request is how a pool
  // runs dry under load.
  //
  // iTunes reports every credited artist as one string, so a track it resolved
  // arrives with a single artist named "Kailash Kher, Naresh Kamath & Paresh
  // Kamath". Left alone that becomes an artist who does not exist. Expanded
  // here - and only when each part checks out - the catalogue stays right
  // without a repair pass having to be run afterwards.
  resolved = {
    ...resolved,
    track: { ...resolved.track, artists: await expandCredit(resolved.track?.artists) },
  };

  const run = async (tx) => {
    const track = resolved.track;
    const albumId = await upsertAlbum(tx, track.album);

    const artistIds = [];
    for (const artist of track.artists || []) {
      artistIds.push({ id: await upsertArtist(tx, artist), ...artist });
    }

    const key = matchKey({
      // The ISRC wins here when present, which is what lets the same recording
      // resolved through two different providers converge on one row.
      isrc: track.isrc,
      deezerId: track.deezerId,
      itunesId: track.itunesId,
      mbid: track.mbid,
      name: track.title,
      extra: [track.artists?.[0]?.name, track.album?.name].filter(Boolean).join(' '),
    });

    const artistCredit = joinArtists(track.artists);

    const { rows } = await tx.query(
      `INSERT INTO tracks (match_key, title, album_id, track_no, disc_no, duration_ms,
                           isrc, deezer_id, itunes_id, mbid, explicit,
                           genre, artist_credit, album_credit,
                           metadata_source, metadata_state, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               'resolved', now())
       ON CONFLICT (match_key) DO UPDATE
          SET title        = EXCLUDED.title,
              album_id     = COALESCE(EXCLUDED.album_id, tracks.album_id),
              track_no     = COALESCE(EXCLUDED.track_no, tracks.track_no),
              disc_no      = COALESCE(EXCLUDED.disc_no, tracks.disc_no),
              duration_ms  = COALESCE(EXCLUDED.duration_ms, tracks.duration_ms),
              isrc         = COALESCE(tracks.isrc, EXCLUDED.isrc),
              deezer_id    = COALESCE(tracks.deezer_id, EXCLUDED.deezer_id),
              itunes_id    = COALESCE(tracks.itunes_id, EXCLUDED.itunes_id),
              mbid         = COALESCE(tracks.mbid, EXCLUDED.mbid),
              explicit     = COALESCE(EXCLUDED.explicit, tracks.explicit),
              genre        = COALESCE(EXCLUDED.genre, tracks.genre),
              artist_credit = EXCLUDED.artist_credit,
              album_credit  = EXCLUDED.album_credit,
              metadata_source = EXCLUDED.metadata_source,
              -- A track a human has corrected stays 'manual'. Automated
              -- resolution must never silently overwrite a manual fix.
              metadata_state  = CASE WHEN tracks.metadata_state = 'manual'
                                     THEN 'manual' ELSE 'resolved' END,
              resolved_at  = now(),
              updated_at   = now()
       RETURNING id, metadata_state`,
      // Order matches the column list above exactly. Kept sequential rather
      // than reordered to fit a legacy parameter numbering, because a
      // mismatched placeholder here writes a track number into a genre column
      // and nothing complains.
      [
        key, //                      $1   match_key
        track.title, //              $2   title
        albumId, //                  $3   album_id
        track.trackNo || null, //    $4   track_no
        track.discNo || null, //     $5   disc_no
        track.durationMs || null, // $6   duration_ms
        track.isrc || null, //       $7   isrc
        track.deezerId || null, //   $8   deezer_id
        track.itunesId || null, //   $9   itunes_id
        track.mbid || null, //       $10  mbid
        track.explicit, //           $11  explicit
        track.genre || null, //      $12  genre
        artistCredit, //             $13  artist_credit
        track.album?.name || null, // $14 album_credit
        resolved.provider, //        $15  metadata_source
      ]
    );
    const trackId = rows[0].id;

    // Replace rather than merge the artist list: if resolution now says two
    // artists where it previously said three, the extra one is wrong and must go.
    await tx.query('DELETE FROM track_artists WHERE track_id = $1', [trackId]);
    for (const artist of artistIds) {
      await tx.query(
        `INSERT INTO track_artists (track_id, artist_id, position, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (track_id, artist_id, role) DO NOTHING`,
        [trackId, artist.id, artist.position ?? 0, artist.role || 'primary']
      );
    }

    return trackId;
  };

  // Accepts an existing client so a bulk import can wrap many tracks in one
  // transaction instead of paying per-track transaction overhead.
  return client ? run(client) : transaction(run);
}

// Stores a track that could not be resolved, so it is visible and fixable in the
// UI rather than silently dropped. The local app skips these: writing a file
// tagged with an unverified video title is exactly what this design avoids.
export async function saveUnresolvedTrack(input, resolution, { client } = {}) {
  const run = async (tx) => {
    // matchKeyExtra keeps two different recordings apart when there is nothing
    // else to tell them by. A track saved from YouTube deliberately carries no
    // artist and no album, so without it every song called "Intro" would
    // collapse into one row through the ON CONFLICT below.
    const key = matchKey({
      name: input.title,
      extra: [input.artist, input.album, input.matchKeyExtra].filter(Boolean).join(' '),
    });

    const { rows } = await tx.query(
      `INSERT INTO tracks (match_key, title, artist_credit, album_credit, duration_ms,
                           isrc, metadata_state, metadata_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'unresolved', $7)
       ON CONFLICT (match_key) DO UPDATE
          SET metadata_state = CASE WHEN tracks.metadata_state IN ('resolved', 'manual')
                                    THEN tracks.metadata_state ELSE 'unresolved' END,
              updated_at = now()
       RETURNING id`,
      [
        key,
        input.title || 'Unknown track',
        input.artist || '',
        input.album || null,
        input.durationMs || null,
        input.isrc || null,
        resolution?.suggestionProvider || null,
      ]
    );
    return rows[0].id;
  };
  return client ? run(client) : transaction(run);
}

// Convenience for the common path: resolve, then persist whichever way it went.
//
// `discardUnverifiedMetadata` changes only the failure case, and exists for
// sources whose own metadata is a guess rather than a record - YouTube, where
// the "artist" was cut out of a video title and the channel may be a re-upload.
// When such a track resolves, the catalogue's metadata is used and the guess is
// discarded as it always is. When it does not resolve, the guess is discarded
// too: the track is stored with a title and nothing else, and waits for a human.
//
// The alternative is writing an unverified artist into the library, where it
// looks exactly like a verified one. A blank field a user can see and fill in
// beats a plausible wrong one they have to notice.
export async function resolveAndSave(input, options = {}) {
  const resolution = await resolveTrack(input, options);
  if (resolution.state === 'resolved') {
    const trackId = await saveResolvedTrack(resolution, options);
    return { trackId, resolution };
  }

  const toStore = options.discardUnverifiedMetadata
    ? { ...input, artist: '', album: null, isrc: null }
    : input;
  const trackId = await saveUnresolvedTrack(toStore, resolution, options);
  return { trackId, resolution };
}
