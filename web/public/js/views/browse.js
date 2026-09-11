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
// These read from the providers rather than from the library, so they work for
// music not added yet. That is the point: this is where you decide what to add.

export async function renderArtistPage(view, context) {
  const deezerId = context.params.id;
  mount(view, spinner('Loading artist...'));

  let data;
  try {
    data = await api.providerArtist(deezerId);
  } catch (err) {
    mount(view, notice(err.message, 'danger', 'warn'));
    return;
  }
  if (!context.isCurrent()) return;

  const { artist, albums, topTracks } = data;
  document.querySelector('#page-title').textContent = artist.name;

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
        albums.length ? `${albums.length} release${albums.length === 1 ? '' : 's'}` : null,
      ],
      actions: [
        h(
          'button.btn.btn-primary',
          {
            type: 'button',
            onclick: () => followDialog(artist, () => toast('Follow saved.', 'ok')),
          },
          icon('heart', 15),
          'Follow'
        ),
      ],
    }),
    topTracks.length
      ? section(
          'Popular',
          // Indexed explicitly. Passing trackRow straight to map would hand it
          // the array index as the position, so the first row would be numbered
          // zero - which is falsy, and fell through to showing artwork while
          // every row below it was numbered.
          h('div.card', h('div.list', topTracks.map((track, i) => trackRow(track, i + 1))))
        )
      : null,
    albums.length
      ? section(
          'Releases',
          h('div.tile-grid', albums.map((album) => albumTile(album, context)))
        )
      : null,
    !topTracks.length && !albums.length
      ? emptyState({
          iconName: 'user',
          title: 'Nothing to show',
          body: 'Deezer has no releases or popular tracks listed for this artist.',
        })
      : null
  );
}

export async function renderAlbumPage(view, context) {
  const deezerId = context.params.id;
  mount(view, spinner('Loading album...'));

  let data;
  try {
    data = await api.providerAlbum({ deezerId });
  } catch (err) {
    mount(view, notice(err.message, 'danger', 'warn'));
    return;
  }
  if (!context.isCurrent()) return;

  const { album, tracks } = data;
  document.querySelector('#page-title').textContent = album.name;

  const addAll = h(
    'button.btn.btn-primary',
    { type: 'button', onclick: () => addTracks(tracks, addAll, context) },
    icon('plus', 15),
    `Add all ${tracks.length}`
  );

  mount(
    view,
    backLink(),
    header({
      image: artwork(album.artworkUrl, { size: 104 }),
      eyebrow: 'Album',
      title: album.name,
      subtitle: album.artistCredit,
      meta: [album.year, `${tracks.length} song${tracks.length === 1 ? '' : 's'}`],
      actions: tracks.length ? [addAll] : [],
    }),
    tracks.length
      ? h('div.card', h('div.list', tracks.map((track, index) => trackRow(track, index + 1))))
      : emptyState({
          iconName: 'album',
          title: 'No tracks listed',
          body: 'The provider returned this album without a track listing.',
        })
  );
}

// --- shared pieces ---------------------------------------------------------

function backLink() {
  return h(
    'button.link-back',
    { type: 'button', onclick: () => window.history.back() },
    icon('chevron-left', 15),
    'Back'
  );
}

// The banner every streaming service opens a page with: the picture, what this
// is, and the one action worth taking from here.
function header({ image, round, eyebrow, title, subtitle, meta, actions }) {
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
      actions?.length ? h('div.page-actions', actions) : null
    )
  );
}

function section(title, body) {
  return h('section.browse-section', h('h3.section-heading', title), body);
}

function trackRow(track, position) {
  const add = h(
    'button.btn.btn-sm.btn-primary',
    { type: 'button', onclick: () => addTracks([track], add) },
    icon('plus', 14),
    'Add'
  );

  return h(
    'div.list-row',
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
    h('div.list-actions', add)
  );
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
    h(
      'div.tile-sub.subtle',
      [album.year, album.albumType].filter(Boolean).join(' · ')
    )
  );
}

async function addTracks(tracks, button, context) {
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
    button.textContent = response.failed ? `Added ${response.added}` : 'Added';
    toast(
      response.failed
        ? `Added ${response.added}, ${response.failed} could not be resolved.`
        : `Added ${response.added} to your library.`,
      response.failed ? 'info' : 'ok'
    );
    context?.refreshStats?.();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}

export { clear };
