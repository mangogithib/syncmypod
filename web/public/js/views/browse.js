import { api } from '../lib/api.js';
import { clear, h, icon, mount } from '../lib/dom.js';
import { artwork, emptyState, formatDuration, notice, spinner, toast } from '../lib/ui.js';
import { followDialog } from './artists.js';

// Artist and album pages.
//
// Search used to end at a list: a row for an album told you it existed and let
// you add the whole thing, and a row for an artist let you follow them. Neither
// let you look. That is the difference between a catalogue and somewhere you
// browse - you find an artist, see what they released, open a record, and take
// the two songs you actually wanted.
//
// **One page per album and per artist, wherever you arrived from.** An album in
// the library used to open a dialog listing only the songs already added, while
// an album from a search opened a page listing the whole release - so the same
// record behaved differently depending on the door you came through, and the
// version you reached from your own library was the less useful of the two.
// Now both open this, and the library route resolves a provider id on the
// server when the album has none stored.
//
// **The listing is the whole release, marked up with what you hold.** Every
// track carries the action that applies to it: Add when it is missing, Remove
// when it is yours. Nothing is hidden - seeing "you have 7 of 12" and being
// able to act on either group is the entire point of the page.

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

// From a search result or another provider page: a provider id and nothing else.
export async function renderAlbumPage(view, context) {
  await albumPage(view, context, { deezerId: context.params.id });
}

// From the library's own Albums grid: a library album id. The server resolves
// the provider id, looking it up by name and artist the first time and
// remembering it, so this page shows the full release rather than the four
// songs that happen to be in the library.
export async function renderLibraryAlbumPage(view, context) {
  await albumPage(view, context, { libraryAlbumId: context.params.id });
}

async function albumPage(view, context, { deezerId = null, libraryAlbumId = null }) {
  mount(view, spinner('Loading album...'));

  // What the library knows, first. It is the part that always works: a page
  // that cannot reach a provider still has to list what you own.
  let libraryAlbum = null;
  if (libraryAlbumId) {
    try {
      libraryAlbum = await api.libraryAlbum(libraryAlbumId);
      deezerId = libraryAlbum.deezerId || null;
    } catch (err) {
      mount(view, notice(err.message, 'danger', 'warn'));
      return;
    }
  }
  if (!context.isCurrent()) return;

  let provider = null;
  if (deezerId) {
    // A provider that is off or that has forgotten this album must not lose the
    // page, so the failure is swallowed and the library listing carries it.
    provider = await api.providerAlbum({ deezerId }).catch(() => null);
  }
  if (!context.isCurrent()) return;

  if (!provider && !libraryAlbum) {
    mount(view, notice('That album could not be found.', 'danger', 'warn'));
    return;
  }

  const album = provider?.album || {
    name: libraryAlbum.name,
    artistCredit: libraryAlbum.artistName,
    artworkUrl: libraryAlbum.artworkUrl,
    year: libraryAlbum.releaseYear,
    totalTracks: libraryAlbum.totalTracks,
  };
  const releaseTracks = provider?.tracks || [];
  document.querySelector('#page-title').textContent = album.name;

  const listSlot = h('div');
  const actionsSlot = h('div.page-actions');

  // Songs of this album already in the library, whether or not the release
  // listing mentions them. A track added from a single, or one the provider has
  // since dropped, is still yours and still has to be visible.
  let mine = [];
  if (libraryAlbumId) {
    mine = await api
      .tracks({ albumId: libraryAlbumId, sort: 'album', limit: 200 })
      .then((data) => data.tracks)
      .catch(() => []);
  }

  await paint();

  mount(
    view,
    backLink(),
    header({
      image: artwork(album.artworkUrl, { size: 104 }),
      eyebrow: 'Album',
      title: album.name,
      subtitle: album.artistCredit,
      meta: [
        album.year,
        releaseTracks.length
          ? `${releaseTracks.length} song${releaseTracks.length === 1 ? '' : 's'}`
          : null,
      ],
      actionsNode: actionsSlot,
    }),
    listSlot
  );

  // Redrawn rather than patched after every add or remove.
  //
  // One request answers "which of these are mine" for the whole listing, and
  // an Add has no way of knowing the id the track landed under - so asking
  // again is both simpler and the only thing that is actually correct.
  async function paint() {
    const known = await alreadyInLibrary(releaseTracks);
    if (!context.isCurrent()) return;

    // Identity first, title second.
    //
    // The server answers on ISRCs and provider ids, which is right and is what
    // makes this work on a page reached from a search. It cannot answer for a
    // track the library resolved through iTunes and the release listing knows
    // through Deezer - no identifier is in both. Inside one album, on the other
    // hand, a title is a reliable key, so the library's own tracks for this
    // album fill the gaps.
    //
    // Each library track is claimed once. An album with the same title twice -
    // a reprise, or two versions of one song - would otherwise mark both rows
    // as the same track, and removing one would appear to remove the other.
    const unclaimed = new Map();
    for (const track of mine) {
      const key = normalise(track.title);
      if (!unclaimed.has(key)) unclaimed.set(key, []);
      unclaimed.get(key).push(track.id);
    }
    const claimed = new Set(known.values());
    for (const list of unclaimed.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (claimed.has(list[i])) list.splice(i, 1);
      }
    }

    releaseTracks.forEach((track, index) => {
      if (known.has(index)) return;
      const list = unclaimed.get(normalise(track.title));
      if (list?.length) {
        const id = list.shift();
        known.set(index, id);
        claimed.add(id);
      }
    });

    // Anything in the library that no row in the release listing accounts for.
    const extras = mine.filter((track) => !claimed.has(track.id));

    const missing = releaseTracks.filter((_track, index) => !known.has(index));

    clear(actionsSlot);
    if (missing.length > 0) {
      const addAll = h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: () => addTracks(missing, addAll, context, refresh),
        },
        icon('plus', 15),
        missing.length === releaseTracks.length
          ? `Add all ${releaseTracks.length}`
          : `Add the other ${missing.length}`
      );
      actionsSlot.append(addAll);
    } else if (releaseTracks.length > 0) {
      actionsSlot.append(h('span.badge.badge-ok', icon('check', 13), 'All in library'));
    }

    mount(
      listSlot,
      releaseTracks.length
        ? h(
            'div.card',
            h(
              'div.list',
              releaseTracks.map((track, index) =>
                trackRow(track, index + 1, {
                  libraryTrackId: known.get(index) || null,
                  context,
                  onChanged: refresh,
                })
              )
            )
          )
        : null,
      extras.length
        ? section(
            releaseTracks.length ? 'Also in your library' : 'In your library',
            h(
              'div.card',
              h(
                'div.list',
                extras.map((track) =>
                  libraryTrackRow(track, { context, onChanged: refresh })
                )
              )
            )
          )
        : null,
      !releaseTracks.length && !extras.length
        ? emptyState({
            iconName: 'album',
            title: 'No tracks listed',
            body: 'The provider returned this album without a track listing.',
          })
        : null
    );
  }

  async function refresh() {
    if (libraryAlbumId) {
      mine = await api
        .tracks({ albumId: libraryAlbumId, sort: 'album', limit: 200 })
        .then((data) => data.tracks)
        .catch(() => mine);
    }
    context.refreshStats?.();
    await paint();
  }
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

export async function renderArtistPage(view, context) {
  await artistPage(view, context, { deezerId: context.params.id });
}

// From the library's own Artists list. Same resolution trick as an album: the
// artist may have been stored from a provider that is not the one these pages
// read, so the id is looked up once server-side and remembered.
export async function renderLibraryArtistPage(view, context) {
  await artistPage(view, context, { libraryArtistId: context.params.id });
}

async function artistPage(view, context, { deezerId = null, libraryArtistId = null }) {
  mount(view, spinner('Loading artist...'));

  let libraryArtist = null;
  if (libraryArtistId) {
    try {
      libraryArtist = await api.libraryArtist(libraryArtistId);
      deezerId = libraryArtist.deezerId || null;
    } catch (err) {
      mount(view, notice(err.message, 'danger', 'warn'));
      return;
    }
  } else if (deezerId) {
    // Arriving from a search: which artist in the library this page is about,
    // so it can lead with the songs already held rather than offering to add
    // forty that are there.
    const found = await api.libraryArtistByDeezer(deezerId).catch(() => ({ artist: null }));
    libraryArtist = found?.artist || null;
    if (libraryArtist) libraryArtist.deezerId = deezerId;
  }
  if (!context.isCurrent()) return;

  const data = deezerId ? await api.providerArtist(deezerId).catch(() => null) : null;
  if (!context.isCurrent()) return;

  if (!data && !libraryArtist) {
    mount(view, notice('That artist could not be found.', 'danger', 'warn'));
    return;
  }

  const artist = data?.artist || {
    name: libraryArtist.name,
    imageUrl: libraryArtist.imageUrl,
    deezerId: null,
  };
  const albums = data?.albums || [];
  const topTracks = data?.topTracks || [];
  document.querySelector('#page-title').textContent = artist.name;

  const mineSlot = h('div');
  const popularSlot = h('div');

  // Songs of theirs already in the library, at the top.
  //
  // This is the question somebody opening an artist from their own library is
  // actually asking, and the page did not answer it: it went straight to the
  // provider's discography, so the library's own songs were the one thing an
  // artist page did not show.
  let mine = [];

  await paintMine();
  await paintPopular();

  mount(
    view,
    backLink(),
    header({
      image: artwork(artist.imageUrl, { size: 104 }),
      round: true,
      eyebrow: 'Artist',
      title: artist.name,
      subtitle: artist.subtitle,
      meta: [
        libraryArtist?.trackCount
          ? `${libraryArtist.trackCount} song${libraryArtist.trackCount === 1 ? '' : 's'} in your library`
          : null,
        albums.length ? `${albums.length} release${albums.length === 1 ? '' : 's'}` : null,
      ],
      actions: artist.deezerId
        ? [
            h(
              'button.btn.btn-primary',
              {
                type: 'button',
                onclick: () =>
                  followDialog({ ...artist, id: libraryArtist?.id }, () =>
                    toast('Follow saved.', 'ok')
                  ),
              },
              icon('heart', 15),
              'Follow'
            ),
          ]
        : [],
    }),
    mineSlot,
    popularSlot,
    albums.length
      ? section('Releases', h('div.tile-grid', albums.map((album) => albumTile(album, context))))
      : null,
    !topTracks.length && !albums.length && !libraryArtist
      ? emptyState({
          iconName: 'user',
          title: 'Nothing to show',
          body: 'No releases or popular tracks are listed for this artist.',
        })
      : null
  );

  async function paintMine() {
    if (!libraryArtist?.id) {
      mount(mineSlot);
      return;
    }
    mine = await api
      .tracks({ artistId: libraryArtist.id, sort: 'album', limit: 200 })
      .then((result) => result.tracks)
      .catch(() => []);
    if (!context.isCurrent()) return;

    mount(
      mineSlot,
      mine.length
        ? section(
            'In your library',
            h(
              'div.card',
              h(
                'div.list',
                mine.map((track) => libraryTrackRow(track, { context, onChanged: refresh }))
              )
            )
          )
        : null
    );
  }

  async function paintPopular() {
    if (!topTracks.length) {
      mount(popularSlot);
      return;
    }
    const known = await alreadyInLibrary(topTracks);
    if (!context.isCurrent()) return;

    mount(
      popularSlot,
      section(
        'Popular',
        h(
          'div.card',
          h(
            'div.list',
            // Indexed explicitly. Passing trackRow straight to map would hand it
            // the array index as the position, so the first row would be numbered
            // zero - which is falsy, and fell through to showing artwork while
            // every row below it was numbered.
            topTracks.map((track, index) =>
              trackRow(track, index + 1, {
                libraryTrackId: known.get(index) || null,
                context,
                onChanged: refresh,
              })
            )
          )
        )
      )
    );
  }

  async function refresh() {
    context.refreshStats?.();
    await paintMine();
    await paintPopular();
  }
}

// --- shared pieces ---------------------------------------------------------

// Which of these provider results the library already holds, as a Map of the
// ref handed over to the library's own track id. The id is what a Remove button
// needs, so answering with one rather than with a yes/no is what lets the same
// row offer either action.
//
// A failure here is not fatal and must not be: the page is still perfectly
// usable showing Add on everything, which is exactly what it did before this
// existed. So it degrades to an empty map rather than an error.
async function alreadyInLibrary(tracks) {
  if (tracks.length === 0) return new Map();
  const items = tracks.map((track, index) => ({
    ref: String(index),
    isrc: track.isrc,
    deezerId: track.deezerId,
    itunesId: track.itunesId,
    mbid: track.mbid,
    title: track.title,
    artist: track.artistCredit,
    album: track.albumName,
  }));
  try {
    const { known } = await api.libraryKnown(items);
    return new Map(Object.entries(known || {}).map(([ref, id]) => [Number(ref), id]));
  } catch {
    return new Map();
  }
}

// Title comparison for "is this the same song", where the two sides came from
// different places. Deliberately blunt - it is deciding whether to list a track
// twice, not what to write to a tag.
function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u0027\u0060]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function backLink() {
  return h(
    'button.link-back',
    { type: 'button', onclick: () => window.history.back() },
    icon('back', 15),
    'Back'
  );
}

// The banner every streaming service opens a page with: the picture, what this
// is, and the one action worth taking from here.
function header({ image, round, eyebrow, title, subtitle, meta, actions, actionsNode }) {
  if (round) image.classList.add('thumb-round');
  return h(
    'div.page-header',
    image,
    h(
      'div.page-header-text',
      h('div.page-eyebrow', eyebrow),
      h('h2.page-heading', title),
      subtitle ? h('div.page-subtitle', subtitle) : null,
      h('div.page-meta', (meta || []).filter(Boolean).join(' · ')),
      actionsNode || (actions?.length ? h('div.page-actions', actions) : null)
    )
  );
}

function section(title, body) {
  return h('section.browse-section', h('h3.section-heading', title), body);
}

// A row in a provider listing: either something to add, or something you
// already have and can take back out.
function trackRow(track, position, { libraryTrackId = null, context, onChanged } = {}) {
  return h(
    `div.list-row${libraryTrackId ? '.row-known' : ''}`,
    position
      ? h('span.track-number', String(position))
      : artwork(track.artworkUrl, { size: 40 }),
    h(
      'div.list-main',
      h('div.list-title', track.title),
      h('div.list-sub', track.artistCredit || 'Unknown artist'),
      track.albumName && !position ? h('div.small.subtle', track.albumName) : null
    ),
    h('span.small.subtle.nowrap', formatDuration(track.durationMs)),
    h(
      'div.list-actions',
      libraryTrackId
        ? removeButton(track.title, libraryTrackId, onChanged)
        : addButton(track, context, onChanged)
    )
  );
}

// A row for something the library holds that the provider listing does not
// cover - a track added from a single, or one the release has since dropped.
function libraryTrackRow(track, { onChanged } = {}) {
  return h(
    'div.list-row.row-known',
    track.trackNo
      ? h('span.track-number', String(track.trackNo))
      : artwork(track.artworkUrl, { size: 40 }),
    h(
      'div.list-main',
      h('div.list-title', track.title),
      h('div.list-sub', track.artistCredit || h('span.subtle', 'No artist yet'))
    ),
    h('span.small.subtle.nowrap', formatDuration(track.durationMs)),
    h('div.list-actions', removeButton(track.title, track.id, onChanged))
  );
}

function addButton(track, context, onChanged) {
  const button = h(
    'button.btn.btn-sm.btn-primary',
    { type: 'button', onclick: () => addTracks([track], button, context, onChanged) },
    icon('plus', 14),
    'Add'
  );
  return button;
}

// No confirmation here, deliberately.
//
// Removing one song from a page you are curating is an ordinary editing move,
// not a destructive one - it leaves the catalogue row alone and the song can be
// added straight back from the row it just left. The Songs list still confirms,
// because a selection of forty is a different kind of mistake.
function removeButton(title, libraryTrackId, onChanged) {
  const button = h(
    'button.btn.btn-sm',
    {
      type: 'button',
      title: `Remove ${title} from your library`,
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Removing...';
        try {
          await api.removeTrack(libraryTrackId);
          toast('Removed from your library.', 'ok');
          await onChanged?.();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
          mount(button, icon('check', 13), 'In library');
        }
      },
    },
    icon('check', 13),
    'In library'
  );
  // The label says what is true and the action is what happens if you press it,
  // which is the pattern a "Following / Unfollow" button uses everywhere.
  button.addEventListener('mouseenter', () => {
    if (!button.disabled) mount(button, icon('x', 13), 'Remove');
  });
  button.addEventListener('mouseleave', () => {
    if (!button.disabled) mount(button, icon('check', 13), 'In library');
  });
  return button;
}

function albumTile(album, context) {
  return h(
    'button.tile',
    {
      type: 'button',
      onclick: () => context.navigate(`album/${album.deezerId}`),
      disabled: !album.deezerId,
    },
    artwork(album.artworkUrl, { large: true }),
    h('div.tile-name', album.name),
    h('div.tile-sub.subtle', [album.year, album.albumType].filter(Boolean).join(' · '))
  );
}

async function addTracks(tracks, button, context, onChanged) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Adding...';
  try {
    const response = await api.addTracks({
      addedVia: 'browse',
      items: tracks.map((track) => ({
        title: track.title,
        artist: track.artistCredit,
        album: track.albumName,
        isrc: track.isrc,
        deezerId: track.deezerId,
        itunesId: track.itunesId,
        mbid: track.mbid,
        durationMs: track.durationMs,
      })),
    });
    toast(
      response.failed
        ? `Added ${response.added}, ${response.failed} could not be resolved.`
        : `Added ${response.added} to your library.`,
      response.failed ? 'info' : 'ok'
    );
    context?.refreshStats?.();
    await onChanged?.();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}

export { clear };
