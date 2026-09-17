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
// Every keystroke would otherwise be an outbound provider request, so searching
// is debounced and superseded requests are cancelled - typing "radiohead" should
// not leave nine in-flight searches racing to paint the results.

export async function renderSearch(view, context) {
  const results = h('div');
  // Everything, unless the user narrows it. Someone typing a name usually wants
  // whichever of the three it turns out to be, and being made to pick the
  // category first is a question the search can answer itself.
  let type = 'all';
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
      typeButton('all', 'All'),
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

  // Any enabled provider is enough. Checked generically so adding one does not
  // mean remembering to extend a hardcoded list here.
  if (!Object.values(appState.providers || {}).some(Boolean)) {
    mount(
      results,
      notice(
        h(
          'div',
          h('strong', 'No metadata provider is configured. '),
          h('a', { href: '#/settings' }, 'Settings')
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
        body: 'Songs, albums and artists together.',
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
          }),
          // The case this exists for. Nothing in the licensed catalogues
          // matched, which for regional releases and small labels is common
          // and does not mean the song is unfindable.
          type === 'track' || type === 'all' ? youtubeFallback(q) : null
        );
        return;
      }

      if (data.groups) {
        // Sections rather than one merged list. A song, an album and an artist
        // are different things to do next - add, open, follow - and a single
        // ranked list would put three kinds of row under one heading.
        mount(
          results,
          data.groups.track.length
            ? group('Songs', h('div.card', h('div.list', data.groups.track.map(trackRow))))
            : null,
          data.groups.album.length
            ? group('Albums', h('div.tile-grid', data.groups.album.map(albumTile)))
            : null,
          data.groups.artist.length
            ? group('Artists', h('div.card', h('div.list', data.groups.artist.map(artistRow))))
            : null,
          youtubeFallback(q)
        );
        return;
      }

      mount(
        results,
        h(
          'p.small.subtle',
          { style: { marginBottom: '12px' } },
          `${data.results.length} result${data.results.length === 1 ? '' : 's'} from ${
            data.providerLabel || data.provider
          }`
        ),
        type === 'artist'
          ? h('div.card', h('div.list', data.results.map(artistRow)))
          : type === 'album'
            ? h('div.tile-grid', data.results.map(albumTile))
            : h('div.card', h('div.list', data.results.map(trackRow))),
        // Offered under every song search, not only the empty ones: a catalogue
        // can return the wrong recording as confidently as it returns nothing.
        type === 'track' ? youtubeFallback(q) : null
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

  function group(title, body) {
    return h('section.browse-section', h('h3.section-heading', title), body);
  }

  function albumTile(result) {
    return h(
      'button.tile',
      {
        type: 'button',
        // A page rather than the old modal. An album is somewhere to look
        // before deciding, not a yes/no about adding all of it - and the modal
        // could not be linked to, shared or navigated back from.
        onclick: () =>
          result.deezerId ? context.navigate(`album/${result.deezerId}`) : openAlbum(result),
      },
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
    const open = () => {
      if (result.deezerId) context.navigate(`artist/${result.deezerId}`);
    };

    return h(
      'div.list-row' + (result.deezerId ? '.list-row-clickable' : ''),
      { onclick: result.deezerId ? open : undefined },
      artwork(result.imageUrl, { size: 42, round: true }),
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
            // Stopped from reaching the row, which would open the page behind
            // the dialog that just opened.
            onclick: (event) => {
              event.stopPropagation();
              followDialog(result, () => toast('Follow saved.', 'ok'), playlists);
            },
          },
          icon('heart', 14),
          'Follow'
        )
      )
    );
  }

  // --- actions -------------------------------------------------------------

  async function addTrack(result, button, item) {
    button.disabled = true;
    button.textContent = 'Adding...';
    try {
      const response = await api.addTracks({
        addedVia: item ? 'youtube' : 'search',
        items: [item || providerItem(result)],
      });
      const entry = response.report[0];
      if (entry?.ok) {
        // A track can be added but unresolved when the provider that answered
        // the search is not the one that can confirm the metadata. Saying so is
        // better than a bare "Added" for something that will not sync.
        button.textContent = 'Added';
        if (entry.metadataState === 'resolved') {
          toast('Added to library.', 'ok');
        } else if (item) {
          // The YouTube path, where empty metadata is the design rather than a
          // failure - so it is phrased as the next step, not as a problem.
          toast('Added. Set the artist and album before it can sync.', 'info');
        } else {
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
        deezerId: result.deezerId,
        itunesId: result.itunesId,
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
            h('div.small.subtle', `${data.tracks.length} tracks from ${data.provider}`)
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
  // a direct lookup rather than searching all over again. The ISRC matters most:
  // it is what lets the server recognise a track it already has under a
  // different provider's id.
  // --- YouTube, on request -------------------------------------------------

  // Kept visually quieter than the main results, and labelled, because a video
  // title is a worse source of metadata than a catalogue entry and the
  // interface should say so rather than present the two as equals.
  function youtubeFallback(q) {
    const container = h('div', { style: { marginTop: '16px' } });

    const button = h(
      'button.btn.btn-sm',
      {
        type: 'button',
        onclick: async () => {
          button.disabled = true;
          button.textContent = 'Searching YouTube...';
          try {
            const data = await api.searchYouTube(q);
            if (!context.isCurrent()) return;
            mount(container, youtubeResults(data.results || []));
          } catch (err) {
            mount(container, notice(err.message, 'warn', 'warn'));
          }
        },
      },
      icon('search', 14),
      'Search on YouTube'
    );

    mount(
      container,
      h(
        'div.search-fallback',
        h(
          'p.small.subtle',
          { style: { margin: '0 0 8px' } },
          "Not what you were looking for? YouTube has music the licensed catalogues do not."
        ),
        button
      )
    );
    return container;
  }

  function youtubeResults(found) {
    if (found.length === 0) {
      return notice('YouTube returned nothing for that search.', 'info', 'search');
    }
    return h(
      'div',
      h(
        'p.small.subtle',
        { style: { margin: '0 0 8px' } },
        `${found.length} from YouTube. Added without an artist or album - `,
        h('span', 'a channel name is not an artist, so you set those yourself afterwards.')
      ),
      h('div.card', h('div.list', found.map(youtubeRow)))
    );
  }

  function youtubeRow(result) {
    const addButton = h(
      'button.btn.btn-sm.btn-primary',
      { type: 'button', onclick: () => addTrack(result, addButton, youtubeItem(result)) },
      icon('plus', 14),
      'Add'
    );

    return h(
      'div.list-row',
      artwork(result.artworkUrl, { size: 40 }),
      h(
        'div.list-main',
        h('div.list-title', result.trackTitle || result.title),
        h('div.list-sub', result.artist || result.channel || 'Unknown artist'),
        h(
          'div.small.subtle',
          result.source === 'music'
            ? [result.album, result.views].filter(Boolean).join(' \u00b7 ')
            : [result.channel, result.views, result.official ? 'Official audio' : null]
                .filter(Boolean)
                .join(' \u00b7 ')
        )
      ),
      h('span.small.subtle.nowrap', formatDuration(result.durationMs)),
      h('div.list-actions', addButton)
    );
  }

  // What gets sent when a YouTube result is added, and it depends on which
  // YouTube answered.
  //
  // **YouTube Music** returns structured fields: the artist, the album and the
  // song separately, each tagged by the API as what it is. That is real
  // catalogue metadata, so it is passed to the resolver as a proper query -
  // and a query with a correct artist resolves far more often than a title on
  // its own, which is the whole reason for preferring this source.
  //
  // **A video result** supplies a title and an address, and nothing else. A
  // channel is not an artist and a video has no album, so filling those fields
  // from it produces a library that looks populated and is wrong - and wrong
  // metadata is harder to notice than missing metadata. skipResolve stops the
  // server guessing too: matching a bare title against the catalogues with no
  // artist to check against returns the wrong recording confidently.
  //
  // Either way, nothing YouTube says is written unless a catalogue confirms it.
  // A track that resolves is stored with the catalogue's metadata; one that
  // does not is stored with its title alone and waits for a human. That is the
  // intended flow, not a shortcoming.
  function youtubeItem(result) {
    if (result.source === 'music' && result.artist) {
      return {
        title: result.title,
        artist: result.artist,
        album: result.album || null,
        durationMs: result.durationMs,
        sourceHint: result.url,
      };
    }

    return {
      title: result.trackTitle || result.title,
      durationMs: result.durationMs,
      sourceHint: result.url,
      skipResolve: true,
    };
  }

  function providerItem(result) {
    return {
      title: result.title,
      artist: result.artistCredit,
      album: result.albumName,
      isrc: result.isrc,
      deezerId: result.deezerId,
      itunesId: result.itunesId,
      mbid: result.mbid,
      durationMs: result.durationMs,
    };
  }

  searchBox.focus();
}
