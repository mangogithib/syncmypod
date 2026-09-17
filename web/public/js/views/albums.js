import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { createSelection, selectable, selectAllRow, selectionBar } from '../lib/select.js';
import {
  artwork,
  confirmDialog,
  debounce,
  emptyState,
  modal,
  notice,
  pager,
  spinner,
  toast,
} from '../lib/ui.js';

// Albums in the library.
//
// The useful number here is "7 of 12": how much of an album is actually
// present. A partial album is the normal state of a library built by adding
// singles, and seeing which ones are incomplete is what prompts filling them in.
//
// **Two shapes, because two different jobs.** The grid is for recognising a
// record by its cover, which is how anybody finds an album they can picture.
// The list is for working through them - twenty rows on screen instead of six,
// with checkboxes, so a batch can be put in a playlist or taken out of the
// library without opening each one. The choice is remembered, because it tends
// to be a preference rather than a per-visit decision.

const VIEW_KEY = 'syncmypod:albums-view';

export async function renderAlbums(view, context) {
  const state = {
    q: '',
    limit: 60,
    offset: 0,
    mode: readMode(),
  };
  const results = h('div');
  const selectionTop = h('div', { hidden: true });
  const selectionHost = h('div', { hidden: true });

  let lastData = { albums: [], total: 0 };
  const selection = createSelection({ onChange: () => paintSelectionBar() });

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

  const modeButton = (mode, label, iconName) =>
    h(
      `button.btn.btn-sm${state.mode === mode ? '.btn-primary' : ''}`,
      {
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-pressed': String(state.mode === mode),
        onclick: () => {
          if (state.mode === mode) return;
          state.mode = mode;
          writeMode(mode);
          selection.clear();
          paintToolbar();
          load();
        },
      },
      icon(iconName, 15)
    );

  const toolbar = h('div.toolbar');

  function paintToolbar() {
    mount(
      toolbar,
      h('div.search-input', icon('search', 15), searchBox),
      h('div', { style: { flex: 1 } }),
      h('div.segmented.segmented-sm', modeButton('grid', 'Grid', 'album'), modeButton('list', 'List', 'list'))
    );
  }

  paintToolbar();
  mount(view, toolbar, selectionTop, results, selectionHost);

  async function load() {
    if (!context.isCurrent()) return;
    mount(results, spinner('Loading albums...'));
    try {
      const data = await api.albums({ q: state.q, limit: state.limit, offset: state.offset });
      if (!context.isCurrent()) return;
      lastData = data;

      if (data.total === 0) {
        selection.clear();
        mount(
          results,
          emptyState({
            iconName: 'album',
            title: state.q ? 'No albums match' : 'No albums yet',
            body: state.q ? 'Try a different search.' : null,
            action: state.q ? null : h('a.btn.btn-primary', { href: '#/search' }, 'Add music'),
          })
        );
        return;
      }

      // Anything no longer on screen is dropped rather than acted on unseen.
      const onPage = new Set(data.albums.map((album) => String(album.id)));
      for (const id of selection.ids) if (!onPage.has(id)) selection.toggle(id);
      selection.setOrder(data.albums.map((album) => album.id));
      selection.resetRows();

      mount(
        results,
        state.mode === 'list' ? albumList(data) : albumGrid(data),
        pager({
          total: data.total,
          limit: state.limit,
          offset: state.offset,
          onChange: ({ limit, offset }) => {
            state.limit = limit;
            state.offset = offset;
            load();
          },
        })
      );
      paintSelectionBar();
    } catch (err) {
      if (err.status === 401) return;
      mount(results, notice(err.message, 'danger', 'warn'));
    }
  }

  // Every album opens its own page now, whether or not it carries a provider
  // id - the server works one out on the way. It used to be a page for some and
  // a dialog listing only your own tracks for others, which made the same
  // record behave differently depending on where it came from.
  const open = (album) => context.navigate(`album-lib/${album.id}`);

  function albumGrid(data) {
    return h(
      'div.tile-grid',
      data.albums.map((album) =>
        h(
          'button.tile',
          { type: 'button', onclick: () => open(album), title: `Open ${album.name}` },
          artwork(album.artworkUrl, { large: true }),
          h('div.tile-name', album.name),
          h('div.tile-sub', album.artistName || 'Various artists'),
          h('div.tile-sub.subtle', countLine(album))
        )
      )
    );
  }

  function albumList(data) {
    return h(
      'div.card',
      // A list has no column headings to put select-all in, so it gets a strip
      // of its own - otherwise this view could only ever be selected one album
      // at a time, which is most of the reason it exists.
      selectAllRow(selection, { total: data.albums.length, label: 'Select all albums listed' }),
      h(
        'div.list',
        data.albums.map((album) => {
          const row = h('div.list-row.row-link');
          const check = selectable(row, album.id, selection);
          row.append(
            h('span.check-cell', check),
            artwork(album.artworkUrl, { size: 40 }),
            h(
              'a.list-main.list-main-link',
              {
                href: `#/album-lib/${album.id}`,
                onclick: (event) => {
                  // Let a selection in progress win: clicking a row while
                  // picking several should extend the selection, not navigate
                  // away from it.
                  if (selection.size > 0) event.preventDefault();
                },
              },
              h('div.list-title', album.name),
              h('div.list-sub', album.artistName || 'Various artists')
            ),
            h('span.small.subtle.nowrap', countLine(album))
          );
          return row;
        })
      )
    );
  }

  function countLine(album) {
    const count =
      album.totalTracks && album.totalTracks !== album.trackCount
        ? `${album.trackCount} of ${album.totalTracks} songs`
        : `${album.trackCount} song${album.trackCount === 1 ? '' : 's'}`;
    return album.releaseYear ? `${count} · ${album.releaseYear}` : count;
  }

  // --- what a selection of albums can do ----------------------------------
  //
  // The reason the list view exists. An album is a handle on its tracks, so
  // both actions are the track actions applied to every song the selected
  // albums hold.
  function paintSelectionBar() {
    selectionBar([selectionTop, selectionHost], selection, {
      total: lastData.albums.length,
      onRender: () => paintSelectionBar(),
      actions: [
        () =>
          h(
            'button.btn.btn-sm',
            { type: 'button', onclick: () => addSelectedToPlaylist() },
            icon('list', 14),
            'Add to playlist'
          ),
        () =>
          h(
            'button.btn.btn-sm.btn-danger',
            { type: 'button', onclick: () => removeSelected() },
            icon('trash', 14),
            'Remove'
          ),
      ],
    });
  }

  const selectedAlbums = () => {
    const wanted = new Set(selection.ids);
    return lastData.albums.filter((album) => wanted.has(String(album.id)));
  };

  // The songs inside a set of albums. Fetched rather than held, because the
  // album rows carry a count and not a track list.
  async function tracksOf(albums) {
    const lists = await Promise.all(
      albums.map((album) =>
        api.tracks({ albumId: album.id, limit: 200, sort: 'album' }).then((data) => data.tracks)
      )
    );
    return lists.flat();
  }

  async function removeSelected() {
    const albums = selectedAlbums();
    if (albums.length === 0) return;
    const songs = albums.reduce((total, album) => total + album.trackCount, 0);

    const confirmed = await confirmDialog({
      title: `Remove ${albums.length} album${albums.length === 1 ? '' : 's'}?`,
      message: `${songs} song${songs === 1 ? '' : 's'} leave your library, every playlist they are in, and the iPod on the next sync.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const tracks = await tracksOf(albums);
      const { removed } = await api.removeTracks(tracks.map((track) => track.id));
      selection.clear();
      toast(`Removed ${removed} song${removed === 1 ? '' : 's'}.`, 'ok');
      context.refreshStats?.();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addSelectedToPlaylist() {
    const albums = selectedAlbums();
    if (albums.length === 0) return;

    let playlists = [];
    try {
      ({ playlists } = await api.playlists());
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (playlists.length === 0) {
      toast('Create a playlist first.', 'info');
      return;
    }

    const select = h(
      'select.select',
      playlists.map((playlist) =>
        h('option', { value: playlist.id }, `${playlist.name} (${playlist.trackCount})`)
      )
    );

    const control = modal({
      title: 'Add to playlist',
      body: [
        h('p.small.muted', `${albums.length} album${albums.length === 1 ? '' : 's'}`),
        h('div.field', h('label', 'Playlist'), select),
      ],
      footer: [
        h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
        h(
          'button.btn.btn-primary',
          {
            type: 'button',
            onclick: async () => {
              try {
                const tracks = await tracksOf(albums);
                const result = await api.addToPlaylist(
                  Number(select.value),
                  tracks.map((track) => track.id)
                );
                toast(
                  result.added === 0
                    ? 'Already in that playlist.'
                    : `Added ${result.added} to the playlist.`,
                  result.added > 0 ? 'ok' : 'info'
                );
                control.close();
                selection.clear();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Add'
        ),
      ],
    });
  }

  await load();
}

// Remembered per browser. A stored value that is not one of the two shapes -
// from an older build, or edited by hand - falls back rather than rendering
// nothing.
function readMode() {
  try {
    const stored = window.localStorage?.getItem(VIEW_KEY);
    return stored === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function writeMode(mode) {
  try {
    window.localStorage?.setItem(VIEW_KEY, mode);
  } catch {
    // Private browsing, or storage turned off. The toggle still works for this
    // visit; only the memory of it is lost.
  }
}
