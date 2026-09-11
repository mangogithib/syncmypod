import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  debounce,
  emptyState,
  formatDuration,
  formatNumber,
  metadataBadge,
  modal,
  notice,
  spinner,
} from '../lib/ui.js';

// Albums in the library, as a grid. Clicking one opens its track list.
//
// The useful number here is "7 of 12": how much of an album is actually present.
// A partial album is the normal state of a library built by adding singles, and
// seeing which ones are incomplete is what prompts filling them in.

export async function renderAlbums(view, context) {
  const state = { q: '', limit: 60, offset: 0 };
  const results = h('div');

  const searchBox = h('input.input', {
    type: 'search',
    placeholder: 'Search albums...',
    'aria-label': 'Search albums',
  });
  searchBox.addEventListener(
    'input',
    debounce(() => {
      state.q = searchBox.value.trim();
      state.offset = 0;
      load();
    })
  );

  mount(
    view,
    h('div.toolbar', h('div.search-input', icon('search', 15), searchBox)),
    results
  );

  async function load() {
    if (!context.isCurrent()) return;
    mount(results, spinner('Loading albums...'));
    try {
      const data = await api.albums({ q: state.q, limit: state.limit, offset: state.offset });
      if (!context.isCurrent()) return;

      if (data.total === 0) {
        mount(
          results,
          emptyState({
            iconName: 'album',
            title: state.q ? 'No albums match' : 'No albums yet',
            body: state.q
              ? 'Try a different search.'
              : 'Albums appear here once you add songs that belong to one.',
            action: state.q ? null : h('a.btn.btn-primary', { href: '#/search' }, 'Add music'),
          })
        );
        return;
      }

      mount(
        results,
        h(
          'div.tile-grid',
          data.albums.map((album) =>
            h(
              'button.tile',
              { type: 'button', onclick: () => openAlbum(album) },
              artwork(album.artworkUrl, { large: true }),
              h('div.tile-name', album.name),
              h('div.tile-sub', album.artistName || 'Various artists'),
              h(
                'div.tile-sub.subtle',
                album.totalTracks && album.totalTracks !== album.trackCount
                  ? `${album.trackCount} of ${album.totalTracks} songs`
                  : `${album.trackCount} song${album.trackCount === 1 ? '' : 's'}`,
                album.releaseYear ? ` - ${album.releaseYear}` : ''
              )
            )
          )
        ),
        data.total > state.limit
          ? h(
              'div.pagination',
              h('span', `Showing ${formatNumber(data.albums.length)} of ${formatNumber(data.total)}`),
              h(
                'div.row',
                h(
                  'button.btn.btn-sm',
                  {
                    type: 'button',
                    disabled: state.offset === 0,
                    onclick: () => {
                      state.offset = Math.max(0, state.offset - state.limit);
                      load();
                    },
                  },
                  'Previous'
                ),
                h(
                  'button.btn.btn-sm',
                  {
                    type: 'button',
                    disabled: state.offset + state.limit >= data.total,
                    onclick: () => {
                      state.offset += state.limit;
                      load();
                    },
                  },
                  'Next'
                )
              )
            )
          : null
      );
    } catch (err) {
      if (err.status === 401) return;
      mount(results, notice(err.message, 'danger', 'warn'));
    }
  }

  // Album tracks in a modal rather than a separate route: it is a short list
  // read in passing, and a full page navigation would lose the grid position.
  async function openAlbum(album) {
    const body = h('div', spinner('Loading tracks...'));
    modal({
      title: album.name,
      wide: true,
      body,
    });

    try {
      const data = await api.tracks({ albumId: album.id, sort: 'album', limit: 200 });
      mount(
        body,
        h(
          'div.row',
          { style: { alignItems: 'flex-start', gap: '16px', marginBottom: '16px' } },
          h('div', { style: { width: '110px', flex: 'none' } }, artwork(album.artworkUrl, { large: true })),
          h(
            'div',
            h('div', { style: { fontWeight: 600 } }, album.name),
            h('div.muted', album.artistName || 'Various artists'),
            h(
              'div.small.subtle',
              [
                album.releaseYear,
                album.albumType,
                `${data.total} song${data.total === 1 ? '' : 's'} in library`,
              ]
                .filter(Boolean)
                .join(' - ')
            )
          )
        ),
        h(
          'div.table-wrap',
          h(
            'table',
            h('thead', h('tr',
              h('th', '#'),
              h('th', 'Title'),
              h('th', 'Artist'),
              h('th.right', 'Time'),
              h('th', 'Metadata'))),
            h(
              'tbody',
              data.tracks.map((track) =>
                h(
                  'tr',
                  h('td.num', track.trackNo || '--'),
                  h('td', h('div.cell-truncate', track.title)),
                  h('td', h('div.cell-truncate.muted', track.artistCredit)),
                  h('td.num', formatDuration(track.durationMs)),
                  h('td.shrink', metadataBadge(track.metadataState))
                )
              )
            )
          )
        )
      );
    } catch (err) {
      mount(body, notice(err.message, 'danger', 'warn'));
    }
  }

  await load();
}
