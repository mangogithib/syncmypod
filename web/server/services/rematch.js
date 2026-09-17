import { many, one, query, transaction } from '../db/pool.js';
import { resolveTrack, saveResolvedTrack } from './resolver.js';

// Another go at the tracks nothing could identify.
//
// A track lands `unresolved` when no catalogue recognised it, which until now
// mostly meant it arrived from YouTube with a video title and no artist - and a
// title alone is not enough to match on. Those tracks sit in the library with an
// empty artist and never sync, waiting for someone to type one in.
//
// YouTube Music changed the odds. It answers with structured fields - the
// artist, the album and the song separately, each tagged by the API - so a
// track that could only offer "Kesariya (From Brahmastra) | Lyric Video" can
// now offer "Kesariya (From Brahmastra)" by "Arijit Singh", and that resolves.
//
// So this walks the unresolved tracks, asks YouTube Music what they are, and
// puts the answer to the ordinary resolver. Nothing is trusted directly: if the
// catalogues still do not recognise it, the track is left exactly as it was.
//
// ── Why this merges rather than updates ─────────────────────────────────────
//
// A resolved track's identity comes from its ISRC or a provider id, so it gets
// a different `match_key` from the name-based one an unresolved track has.
// Saving the resolution therefore writes a *different row* - and often finds an
// existing one, because the same recording may already be in the library from a
// search. Updating the old row in place would leave two rows for one recording;
// dropping it would take its playlist entries with it.
//
// So the old row's references are moved onto the resolved row first, and only
// then is it deleted. Every playlist keeps its song, and the library keeps its
// count.

const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Running it without being asked
// ---------------------------------------------------------------------------
//
// This used to be a button. A notice appeared above the Songs list saying "6
// songs have no artist yet", and pressing it identified three of them - which
// makes the button a chore rather than a choice, because nobody would ever
// press "no thanks, leave them broken".
//
// The reason the second pass finds what the first missed is not cleverness. An
// import of three hundred tracks is three hundred provider lookups in a burst,
// and Deezer and iTunes both rate limit; a lookup that comes back empty under
// load is indistinguishable, at the time, from a track nothing knows about. So
// the fix is a retry, not a prompt, and it belongs after every import rather
// than in the user's hands.
//
// Three properties keep it cheap and safe to run unattended:
//
//   * one pass per user at a time, so two imports finishing together do not
//     start two passes over the same rows;
//   * a pause first, so the retry does not land inside the same burst that
//     caused the misses;
//   * no job row. The button's pass created one, because someone was watching
//     it. Nothing is watching this, and an import history filled with
//     "Looking up unresolved songs" says nothing worth reading.
const inFlight = new Set();

// How long to wait after an import before retrying. Long enough for a provider
// rate-limit window to pass, short enough that the songs are identified before
// anyone goes looking for them.
const RETRY_DELAY_MS = 20_000;

export function scheduleRematch(userId, { delayMs = RETRY_DELAY_MS } = {}) {
  const key = String(userId);
  if (inFlight.has(key)) return false;
  inFlight.add(key);

  // unref, so a pending retry never holds the process open during a shutdown.
  const timer = setTimeout(async () => {
    try {
      const outstanding = await countUnresolved(userId);
      if (outstanding === 0) return;
      const report = await rematchUnresolved(userId);
      if (report.resolved > 0 || report.joined > 0) {
        console.log(
          `[rematch] identified ${report.resolved} and folded ${report.joined} ` +
            `second copies, of ${report.examined} examined, for user ${userId}`
        );
      }
    } catch (err) {
      // Nothing is waiting on this and nothing depends on it. A track that
      // stays unresolved is exactly what it was before the pass ran.
      console.error(`[rematch] background pass for user ${userId} failed:`, err.message);
    } finally {
      inFlight.delete(key);
    }
  }, delayMs);
  timer.unref?.();
  return true;
}

// Which tracks a pass will look at.
//
// `unresolved` is the obvious set. The second half is not: a track can read
// `manual` and still have no artist, because `manual` used to be set on any
// save at all - including one that changed nothing. Those are not corrections
// anybody made; they are songs with nothing in them that had been quietly
// exempted from the one pass that could have filled them in.
//
// A blank artist is what makes it safe to include them. `manual` is sacred
// because it protects a human's answer, and an empty field is not an answer.
const REMATCHABLE = `(
  t.metadata_state = 'unresolved'
  OR (t.metadata_state = 'manual' AND coalesce(t.artist_credit, '') = '')
)`;

export async function countUnresolved(userId) {
  const row = await one(
    `SELECT count(*)::int AS n
       FROM tracks t
       JOIN library_tracks lt ON lt.track_id = t.id
      WHERE lt.user_id = $1 AND ${REMATCHABLE}`,
    [userId]
  );
  return row?.n || 0;
}

// Starts a pass in the background and returns a job id to poll.
//
// A pass over two hundred tracks is two hundred YouTube Music lookups and as
// many resolver calls after them - minutes, not seconds. Doing that inside the
// request would be killed by a proxy long before it finished, which is the same
// lesson the bulk importers already learned, so it uses the same job row and
// the same polling the UI already knows how to do.
export async function startRematch(userId, { limit = DEFAULT_LIMIT } = {}) {
  const total = await countUnresolved(userId);
  if (total === 0) throw new Error('There are no unresolved songs to look up.');

  const job = await one(
    `INSERT INTO import_jobs (user_id, source, source_name, status, total)
     VALUES ($1, 'rematch', $2, 'running', $3)
     RETURNING id`,
    [userId, 'Looking up unresolved songs', Math.min(total, limit)]
  );

  // Not awaited: the caller returns the job id straight away. The catch is
  // essential - an unhandled rejection here would take the process down.
  runRematchJob(job.id, userId, limit).catch((err) =>
    console.error(`[rematch] job ${job.id} crashed:`, err.message)
  );

  return { jobId: job.id, total: Math.min(total, limit) };
}

async function runRematchJob(jobId, userId, limit) {
  try {
    const report = await rematchUnresolved(userId, {
      limit,
      onProgress: async (progress) => {
        // Every ten, matching the importers: the UI polls more slowly than
        // that, so per-track writes would be pure load.
        if (progress.examined % 10 !== 0) return;
        await query(
          `UPDATE import_jobs SET processed = $2, added = $3, failed = $4 WHERE id = $1`,
          [jobId, progress.examined, progress.resolved, progress.failed]
        ).catch(() => {});
      },
    });

    await query(
      `UPDATE import_jobs
          SET status = 'done', processed = $2, added = $3, skipped = $4, failed = $5,
              report = $6::jsonb, finished_at = now()
        WHERE id = $1`,
      [
        jobId,
        report.examined,
        report.resolved,
        report.stillUnknown,
        report.failed,
        JSON.stringify(
          report.fixed.map((entry) => ({
            title: entry.was,
            state: 'resolved',
            reason: `Now ${entry.artist} - ${entry.now}`,
          }))
        ),
      ]
    );
  } catch (err) {
    await query(
      `UPDATE import_jobs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`,
      [jobId, String(err.message).slice(0, 2000)]
    ).catch(() => {});
    throw err;
  }
}

// Runs through the unresolved tracks and upgrades what it can.
//
// `onProgress` is called after each track so a job row can be kept current.
export async function rematchUnresolved(userId, { limit = DEFAULT_LIMIT, onProgress } = {}) {
  const pending = await many(
    `SELECT t.id, t.title, t.duration_ms AS "durationMs", t.match_key AS "matchKey",
            t.artist_credit AS "artistCredit"
       FROM tracks t
       JOIN library_tracks lt ON lt.track_id = t.id
      WHERE lt.user_id = $1 AND ${REMATCHABLE}
   ORDER BY t.id
      LIMIT $2`,
    [userId, limit]
  );

  const report = {
    examined: 0,
    resolved: 0,
    stillUnknown: 0,
    merged: 0,
    joined: 0,
    failed: 0,
    fixed: [],
  };

  for (const track of pending) {
    report.examined++;
    try {
      const outcome = await rematchOne(userId, track);
      if (outcome.resolved) {
        report.resolved++;
        if (outcome.merged) report.merged++;
        if (report.fixed.length < 100) {
          report.fixed.push({ was: track.title, now: outcome.title, artist: outcome.artist });
        }
      } else if (outcome.joined) {
        report.joined++;
        console.log(
          `[rematch] "${track.title}" was a second copy of a song already in the library`
        );
      } else {
        report.stillUnknown++;
      }
    } catch (err) {
      report.failed++;
      console.error(`[rematch] track ${track.id} failed:`, err.message);
    }
    onProgress?.(report);
  }

  return report;
}

async function rematchOne(userId, track) {
  // Just ask the resolver again.
  //
  // This used to do its own YouTube Music lookup with its own guards, because
  // the resolver had no tier that could answer a title-only query. It has one
  // now, with the same two checks - title word overlap and a duration window -
  // applied to every route rather than only to this one. Keeping a second copy
  // here would mean two definitions of "close enough" drifting apart.
  //
  // So this is a re-run, and the only thing it adds is what to do with the
  // answer: merge it into whatever row the resolved identity belongs to.
  const resolution = await resolveTrack({
    title: track.title,
    durationMs: track.durationMs,
  });

  if (resolution.state !== 'resolved') {
    // Nothing recognised it. Before giving up, ask whether the library already
    // holds this song under a row that something *did* recognise.
    const twin = await identifiedTwin(userId, track);
    if (twin) {
      await absorb(track.id, twin.id);
      return { resolved: false, joined: true, into: twin.id };
    }
    return { resolved: false };
  }

  const resolvedId = await saveResolvedTrack(resolution);
  const merged = String(resolvedId) !== String(track.id);
  if (merged) await absorb(track.id, resolvedId);

  return {
    resolved: true,
    merged,
    title: resolution.track.title,
    artist: resolution.track.artists?.map((a) => a.name).join(', ') || '',
  };
}

// The row this placeholder is a second copy of, if there is exactly one.
//
// **Why this is allowed to act on its own where the review is not.** The
// duplicates review compares two rows that both have an identity, and deciding
// whether they are one recording or a song and its remaster is a judgement. This
// is the other shape: one side is a placeholder - nothing recognised it, so all
// it carries is a title somebody typed into a video description - and the other
// has been confirmed against a catalogue. A placeholder is not a claim about a
// different recording; it is the absence of a claim.
//
// Four conditions, and every one of them is doing work:
//
//   * the twin must be `resolved`, so a catalogue vouches for it. Two
//     placeholders are never merged into each other.
//   * the normalised titles must match exactly. Decorations stay, so a song and
//     its reprise or unplugged version are different titles and stay apart.
//   * the placeholder must have no artist, or share a name with the twin. This
//     is what rejects a cover: "Kagaz" by somebody else has no name in common
//     with "Kagaz" by Garvit-Priyansh, and stays its own song.
//   * there must be exactly one candidate. Two identified rows with the same
//     title is precisely the ambiguous case, and it belongs in the review.
async function identifiedTwin(userId, track) {
  const candidates = await many(
    `SELECT t.id, t.artist_credit AS "artistCredit"
       FROM library_tracks lt
       JOIN tracks t ON t.id = lt.track_id
      WHERE lt.user_id = $1
        AND t.id <> $2
        AND t.metadata_state = 'resolved'
        AND regexp_replace(lower(t.title), '[^a-z0-9]+', '', 'g') = $3`,
    [userId, track.id, normaliseTitle(track.title)]
  );
  if (candidates.length !== 1) return null;

  const twin = candidates[0];
  const mine = nameTokens(track.artistCredit);
  if (mine.size === 0) return twin; // nothing to contradict it
  const theirs = nameTokens(twin.artistCredit);
  return [...mine].some((token) => theirs.has(token)) ? twin : null;
}

function normaliseTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// The words in an artist credit, for asking whether two credits name any of the
// same people. Compared as a set rather than as a string because the two sides
// come from different places and never agree on spelling: the same song arrived
// once as "Garvit Priyansh,Jonita,Aniket" and once as "Garvit-Priyansh, Priyansh
// Srivastava, Jonita Gandhi, Garvit Soni, Aniket Shukla".
//
// Short words are dropped. "the", "dj" and an initial are shared by artists who
// have nothing to do with each other, and one of them matching is not evidence.
function nameTokens(credit) {
  return new Set(
    String(credit || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

// Moves everything pointing at `oldId` onto `newId`, then deletes the old row.
//
// One transaction, because a half-done move is a library that has lost a song.
// Every insert is ON CONFLICT DO NOTHING: the resolved track may already be in
// the same playlist or library, in which case the old row's entry is simply
// dropped rather than duplicated.
//
// Exported because merging two rows by hand is the same operation. A pass that
// resolves a track finds it has a twin; a person looking at a duplicates list
// has already found one. What has to happen to the references is identical, and
// there should be exactly one implementation of it.
export async function absorb(oldId, newId) {
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO library_tracks (user_id, track_id, added_via, added_at, source_hint, rating)
       SELECT user_id, $2, added_via, added_at, source_hint, rating
         FROM library_tracks WHERE track_id = $1
       ON CONFLICT (user_id, track_id) DO NOTHING`,
      [oldId, newId]
    );

    // Position is kept, so a song does not jump to the end of a playlist just
    // because its metadata was finally worked out.
    await tx.query(
      `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
       SELECT playlist_id, $2, position, added_at FROM playlist_tracks WHERE track_id = $1
       ON CONFLICT DO NOTHING`,
      [oldId, newId]
    );

    // What is physically on an iPod. Moving this is what stops the next sync
    // deciding the old track left the library and the new one needs copying -
    // the file on the device is the same file.
    await tx.query(
      `INSERT INTO device_tracks (device_id, track_id, state, synced_at, file_size,
                                  bitrate, format, source_used, error)
       SELECT device_id, $2, state, synced_at, file_size, bitrate, format,
              source_used, error
         FROM device_tracks WHERE track_id = $1
       ON CONFLICT DO NOTHING`,
      [oldId, newId]
    );

    await tx.query('DELETE FROM tracks WHERE id = $1', [oldId]);
  });
}
