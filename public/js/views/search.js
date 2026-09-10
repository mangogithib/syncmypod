import { state as appState } from '../app.js';
import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  debounce,
  emptyState,
  formatDuration,
  modal,
  notice,
  spinner,
  toast,
} from '../lib/ui.js';
import { followDialog } from './artists.js';

// Add music: search a provider catalogue, then add tracks, whole albums, or
// follow an artist.
//
// Searching hits Spotify or MusicBrainz on every request, so it is debounced and
// requests are cancelled when superseded - typing "radiohead" should not leave
// nine in-flight searches racing to paint the results.

export async function renderSearch(view, context) {
  const results = h('div');
  let type = 'track';
  let controller = null;
  let playlists = [];

  const searchBox = h('input.input', {
    type: 'search',
    placeholder: 'Search for a song, album or artist...',
    'aria-label': 'Search for music',
    autocomplete: 'off',
  });

  const typeButton = (key, label) =>
    h(
      `button.btn.btn-sm${type === key ? '.btn-primary' : ''}`,
      {
        type: 'button',
        onclick: () => {
          type = key;
          paintToolbar();
          if (searchBox.value.trim().length >= 2) run();
        },
      },
      label
    );

  const toolbar = h('div.toolbar');

  function paintToolbar() {
    mount(
      toolbar,
      h('div.search-input', icon('search', 15), searchBox),
      typeButton('track', 'Songs'),
      typeButton('album', 'Albums'),
      typeButton('artist', 'Artists')
    );
    // Repainting the toolbar replaces the input's parent, so focus and the
    // caret position have to be restored or switching type loses the cursor.
    const value = searchBox.value;
    searchBox.value = value;
    if (document.activeElement !== searchBox) return;
    searchBox.focus();
    searchBox.setSelectionRange(value.length, value.length);
  }

  searchBox.addEventListener('input', debounce(() => run()));
  searchBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  paintToolbar();
  mount(view, toolbar, results);

  if (!appState.providers.spotify && !appState.providers.musicbrainz) {
    mount(
      results,
      notice(
        h(
          'div',
          h('strong', 'No metadata provider is configured. '),
          h('span', 'Searching needs Spotify credentials or a MusicBrainz contact address. '),
          h('a', { href: '#/settings' }, 'Set one up')
        ),
        'warn',
        'warn'
      )
    );
  } else {
    mount(
      results,
      emptyState({
        iconName: 'search',
        title: 'Search for music to add',
        body:
          'Results come from Spotify first, then MusicBrainz. Metadata is taken from whichever answered, not from wherever the audio eventually comes from.',
      })
    );
  }

  api.playlists()
    .then((data) => { playlists = data.playlists; })
    .catch(() => {});

  async function run() {
    const q = searchBox.value.trim();
    if (q.length < 2) return;
    if (!context.isCurrent()) return;

    // Cancel whatever was in flight: its answer is for a query the user has
    // already moved past.
    controller?.abort();
    controller = new AbortController();

    mount(results, spinner('Searching...'));

    try {
      const data = await api.searchProviders(q, type, controller.signal);
      if (!context.isCurrent()) return;

      if (data.results.length === 0) {
        mount(
          results,
          emptyState({
            iconName: 'search',
            title: 'Nothing found',
            body: `No ${type}s matched "${q}". Try fewer words, or a different spelling.`,
          })
        );
        return;
      }

      mount(
        results,
        h(
          'p.small.subtle',
          { style: { marginBottom: '12px' } },
          `${data.results.length} result${data.results.length === 1 ? '' : 's'} from ${
            data.provider === 'spotify' ? 'Spotify' : 'MusicBrainz'
          }`
        ),
        type === 'artist'
          ? h('div.card', h('div.list', data.results.map(artistRow)))
          : type === 'album'
            ? h('div.tile-grid', data.results.map(albumTile))
            : h('div.card', h('div.list', data.results.map(trackRow)))
      );
    } catch (err) {
      // An aborted request is the expected outcome of typing, not a failure.
      if (err.name === 'AbortError') return;
      if (err.status === 401) return;
      mount(results, notice(err.message, 'danger', 'warn'));
    }
  }

  // --- result rows ---------------------------------------------------------

  function trackRow(result) {
    const addButton = h(
      'button.btn.btn-sm.btn-primary',
      { type: 'button', onclick: () => addTrack(result, addButton) },
      icon('plus', 14),
      'Add'
    );

    return h(
      'div.list-row',
      artwork(result.artworkUrl, { size: 40 }),
      h(
        'div.list-main',
        h('div.list-title', result.title),
        h('div.list-sub', result.artistCredit || 'Unknown artist'),
        h(
          'div.small.subtle',
          [result.albumName, result.year, result.explicit ? 'Explicit' : null]
            .filter(Boolean)
            .join(' - ')
        )
      ),
      h('span.small.subtle.nowrap', formatDuration(result.durationMs)),
      h(
        'div.list-actions',
        addButton,
        playlists.length > 0
          ? h(
              'button.icon-btn',
              {
                type: 'button',
                title: 'Add to a playlist',
                'aria-label': `Add ${result.title} to a playlist`,
                onclick: () => addTrackToPlaylist(result),
              },
              icon('list', 16)
            )
          : null
      )
    );
  }

  function albumTile(result) {
    return h(
      'button.tile',
      { type: 'button', onclick: () => openAlbum(result) },
      artwork(result.artworkUrl, { large: true }),
      h('div.tile-name', result.name),
      h('div.tile-sub', result.artistCredit || 'Various artists'),
      h(
        'div.tile-sub.subtle',
        [result.year, result.totalTracks ? `${result.totalTracks} songs` : null]
          .filter(Boolean)
          .join(' - ')
      )
    );
  }

  function artistRow(result) {
    return h(
      'div.list-row',
      artwork(result.imageUrl, { size: 42 }),
      h(
        'div.list-main',
        h('div.list-title', result.name),
        result.subtitle ? h('div.list-sub', result.subtitle) : null
      ),
      h(
        'div.list-actions',
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: () => followDialog(result, () => toast('Follow saved.', 'ok'), playlists),
          },
          icon('heart', 14),
          'Follow'
        )
      )
    );
  }

  // --- actions -------------------------------------------------------------

  async function addTrack(result, button) {
    button.disabled = true;
    button.textContent = 'Adding...';
    try {
      const response = await api.addTracks({
        addedVia: 'search',
        items: [providerItem(result)],
      });
      const entry = response.report[0];
      if (entry?.ok) {
        // A track can be added but unresolved when the provider that answered
        // the search is not the one that can confirm the metadata. Saying so is
        // better than a bare "Added" for something that will not sync.
        if (entry.metadataState === 'resolved') {
          button.textContent = 'Added';
          toast('Added to library.', 'ok');
        } else {
          button.textContent = 'Added';
          toast('Added, but the metadata needs review before it can sync.', 'info');
        }
        context.refreshStats();
      } else {
        throw new Error(entry?.error || 'Could not add that track.');
      }
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = 'Add';
    }
  }

  async function addTrackToPlaylist(result) {
    const select = h(
      'select.select',
      playlists.map((playlist) => h('option', { value: playlist.id }, playlist.name))
    );

    const control = modal({
      title: 'Add to playlist',
      body: [h('p.small.muted', result.title), h('div.field', h('label', 'Playlist'), select)],
      footer: [
        h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
        h(
          'button.btn.btn-primary',
          {
            type: 'button',
            onclick: async () => {
              try {
                await api.addTracks({
                  addedVia: 'search',
                  playlistId: Number(select.value),
                  items: [providerItem(result)],
                });
                toast('Added to library and playlist.', 'ok');
                context.refreshStats();
                control.close();
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

  // Whole-album add. The track list is fetched from the provider and shown for
  // confirmation first: adding 40 tracks by accident is annoying to undo.
  async function openAlbum(result) {
    const body = h('div', spinner('Loading album...'));
    const addAll = h('button.btn.btn-primary', { type: 'button', disabled: true }, 'Add all');
    const control = modal({
      title: result.name,
      wide: true,
      body,
      footer: [
        h('button.btn', { type: 'button', onclick: () => control.close() }, 'Close'),
        addAll,
      ],
    });

    try {
      const data = await api.providerAlbum({
        spotifyId: result.spotifyId,
        mbid: result.mbid,
      });

      const checkboxes = new Map();
      mount(
        body,
        h(
          'div.row',
          { style: { alignItems: 'flex-start', gap: '16px' } },
          h('div', { style: { width: '96px', flex: 'none' } },
            artwork(data.album?.artworkUrl, { large: true })),
          h(
            'div',
            h('div', { style: { fontWeight: 600 } }, data.album?.name || result.name),
            h('div.muted', data.album?.artistCredit || result.artistCredit || ''),
            h('div.small.subtle', `${data.tracks.length} tracks from ${data.provider === 'spotify' ? 'Spotify' : 'MusicBrainz'}`)
          )
        ),
        h(
          'div.card',
          { style: { marginTop: '16px' } },
          h(
            'div.list',
            data.tracks.map((track, index) => {
              const checkbox = h('input', { type: 'checkbox', checked: true });
              checkboxes.set(index, { checkbox, track });
              return h(
                'label.list-row',
                { style: { cursor: 'pointer' } },
                checkbox,
                h('span.small.subtle', { style: { width: '22px' } }, String(index + 1)),
                h(
                  'div.list-main',
                  h('div.list-title', track.title),
                  h('div.list-sub', track.artistCredit)
                ),
                h('span.small.subtle', formatDuration(track.durationMs))
              );
            })
          )
        )
      );

      addAll.disabled = false;
      addAll.textContent = `Add ${data.tracks.length} tracks`;
      addAll.addEventListener('click', async () => {
        const chosen = [...checkboxes.values()]
          .filter((entry) => entry.checkbox.checked)
          .map((entry) => providerItem(entry.track));

        if (chosen.length === 0) {
          toast('Nothing selected.', 'info');
          return;
        }

        addAll.disabled = true;
        addAll.textContent = 'Adding...';
        try {
          const response = await api.addTracks({ addedVia: 'search', items: chosen });
          toast(
            response.failed > 0
              ? `Added ${response.added}, ${response.failed} failed.`
              : `Added ${response.added} tracks.`,
            response.failed > 0 ? 'info' : 'ok'
          );
          context.refreshStats();
          control.close();
        } catch (err) {
          toast(err.message, 'error');
          addAll.disabled = false;
          addAll.textContent = 'Add all';
        }
      });
    } catch (err) {
      mount(body, notice(err.message, 'danger', 'warn'));
    }
  }

  // Every identifier the provider gave is passed through, so the server can do
  // a direct lookup rather than searching all over again.
  function providerItem(result) {
    return {
      title: result.title,
      artist: result.artistCredit,
      album: result.albumName,
      isrc: result.isrc,
      spotifyId: result.spotifyId,
      mbid: result.mbid,
      durationMs: result.durationMs,
    };
  }

  searchBox.focus();
}
