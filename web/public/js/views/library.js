import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { createSelection, selectable, selectionBar } from '../lib/select.js';
import { suggestInput } from '../lib/suggest.js';
import {
  artwork,
  confirmDialog,
  debounce,
  emptyState,
  field,
  formatDuration,
  modal,
  notice,
  pager,
  spinner,
  toast,
} from '../lib/ui.js';

// The songs table: search, filter, sort, page, and per-track actions.
//
// Filter and sort state lives in the URL hash query string, so a filtered view
// can be linked to and survives a reload. The Overview links straight to
// #/library?state=flagged on the strength of that.
//
// Two notices used to live at the top of this page and both are gone, for the
// same reason: each asked the user to authorise something that has a right
// answer. Looking up the songs with no artist, and folding a second copy of a
// song into the one the catalogue recognised, are both things the server now
// does on its own after every import. See services/rematch.js.

export async function renderLibrary(view, context) {
  const query = readQuery();

  const state = {
    q: query.get('q') || '',
    sort: query.get('sort') || 'added',
    state: query.get('state') || '',
    limit: 50,
    offset: Number(query.get('offset')) || 0,
    playlists: [],
  };

  const results = h('div');
  // Outside `results`, so re-rendering the table does not take the bar with it.
  // Two of them: a selection made at the foot of fifty rows should not need a
  // scroll back to the top before it can be acted on, and the reverse is just
  // as true.
  const selectionTop = h('div', { hidden: true });
  const selectionHost = h('div', { hidden: true });

  // `lastData` is what the bar needs to turn selected ids back into tracks for
  // a confirmation message, and to know how many rows are on this page.
  let lastData = { tracks: [], total: 0 };
  const selection = createSelection({ onChange: () => renderSelectionBar() });

  const searchBox = h('input.input', {
    type: 'search',
    placeholder: 'Search songs, artists, albums...',
    value: state.q,
    'aria-label': 'Search library',
  });

  const stateFilter = h(
    'select.select',
    {
      style: { width: 'auto' },
      'aria-label': 'Filter songs',
      onchange: () => {
        state.state = stateFilter.value;
        state.offset = 0;
        load();
      },
    },
    h('option', { value: '' }, 'All songs'),
    // Named for what is true of the song rather than for the resolver's state
    // machine. "Unresolved" and "Pending" meant nothing to anybody reading
    // them, and one of the two never occurred at all.
    h('option', { value: 'no-artist' }, 'No artist'),
    h('option', { value: 'flagged' }, 'No artist, still flagged'),
    // Not about metadata at all, and deliberately in the same control: both are
    // answers to "which of these songs needs me to do something".
    h('option', { value: 'sync-failed' }, 'Failed to sync'),
    h('option', { value: 'manual' }, 'Manually edited')
  );
  stateFilter.value = state.state;

  const onSearch = debounce(() => {
    state.q = searchBox.value.trim();
    state.offset = 0;
    load();
  });
  searchBox.addEventListener('input', onSearch);

  mount(
    view,
    h(
      'div.toolbar',
      h('div.search-input', icon('search', 15), searchBox),
      stateFilter,
      h('div', { style: { flex: 1 } }),
      h(
        'a.btn.btn-primary',
        { href: '#/search' },
        icon('plus', 15),
        'Add music'
      )
    ),
    selectionTop,
    results,
    selectionHost
  );

  // Playlists are needed by the "add to playlist" action on every row, so they
  // are fetched once for the page rather than per click.
  api.playlists()
    .then(({ playlists }) => { state.playlists = playlists; })
    .catch(() => {});

  async function load() {
    if (!context.isCurrent()) return;
    writeQuery(state);
    mount(results, spinner('Loading songs...'));

    try {
      const data = await api.tracks({
        q: state.q,
        sort: state.sort,
        state: state.state,
        limit: state.limit,
        offset: state.offset,
      });
      if (!context.isCurrent()) return;
      lastData = data;
      // Anything no longer on screen is dropped rather than acted on unseen:
      // paging away from a selection and then pressing Remove should not delete
      // rows the user can no longer see.
      const onPage = new Set(data.tracks.map((track) => String(track.id)));
      for (const id of selection.ids) if (!onPage.has(id)) selection.toggle(id, { additive: true });
      selection.setOrder(data.tracks.map((track) => track.id));
      // The old rows are about to be thrown away; keeping them in the registry
      // would leak a node per page turn and repaint elements nothing can see.
      selection.resetRows();
      mount(results, renderTable(data));
      renderSelectionBar();
    } catch (err) {
      if (err.status === 401) return;
      mount(results, notice(err.message, 'danger', 'warn'));
    }
  }

  function renderTable(data) {
    if (data.total === 0) {
      return emptyState({
        iconName: 'music',
        title: state.q || state.state ? 'No songs match' : 'Your library is empty',
        body: state.q || state.state ? 'Try a different search.' : null,
        action:
          state.q || state.state
            ? h('button.btn', {
                type: 'button',
                onclick: () => {
                  state.q = '';
                  state.state = '';
                  searchBox.value = '';
                  stateFilter.value = '';
                  state.offset = 0;
                  load();
                },
              }, 'Clear filters')
            : h('a.btn.btn-primary', { href: '#/search' }, 'Add music'),
      });
    }

    const sortHeader = (label, key, extraClass = '') =>
      h(
        `th.sortable${extraClass}`,
        {
          onclick: () => {
            state.sort = key;
            state.offset = 0;
            load();
          },
          title: `Sort by ${label.toLowerCase()}`,
        },
        label,
        state.sort === key ? h('span.sort-arrow', '▼') : null
      );

    return [
      h(
        'div.table-wrap',
        h(
          'table',
          h(
            'thead',
            h(
              'tr',
              // Select-all lives here rather than as a "Select page" button in
              // the action bar. It is where every list with checkboxes has put
              // it, and unlike a button in the bar it can show a half-selected
              // state - which is what makes one press mean "take the rest".
              h(
                'th.col-check',
                { 'aria-label': 'Select all' },
                selection.headerCheckbox({ label: 'Select all songs on this page' })
              ),
              sortHeader('Title', 'title'),
              sortHeader('Artist', 'artist', '.col-artist'),
              // Classed so a phone can drop them. Title, artist and the row
              // actions are what a song list is for; a year and a running time
              // are not worth a sideways scroll on a 390px screen.
              sortHeader('Album', 'album', '.col-album'),
              sortHeader('Year', 'year', '.right.col-year'),
              sortHeader('Time', 'duration', '.right.col-time'),
              h('th.col-actions', { 'aria-label': 'Actions' })
            )
          ),
          h(
            'tbody',
            data.tracks.map((track) => trackRow(track))
          )
        )
      ),
      pagination(data),
    ];
  }

  function trackRow(track) {
    // Built empty first: `selectable` needs the row element to attach the
    // shift-click and long-press handlers to, and the checkbox it returns goes
    // inside that same row.
    const row = h('tr');
    const check = selectable(row, track.id, selection);

    row.append(
      h('td.col-check', check),
      h(
        'td',
        h(
          'div.track-cell',
          artwork(track.artworkUrl, { size: 36 }),
          h(
            'div',
            { style: { minWidth: 0 } },
            // The unresolved marker sits against the title rather than in a
            // column of its own. Almost every track resolves, so a dedicated
            // column was an empty column on every screen it was wide enough to
            // show - it carried a heading and no information. Beside the title
            // it appears only on the few rows that need a human, which is the
            // only thing it was ever for.
            h(
              'div.track-title-line',
              h('span.track-title', track.title),
              // No metadata badge, deliberately.
              //
              // "Unresolved" was a second name for something the Artist column
              // already says: on the real library it was 14 of 14 the same set
              // as "has no artist", and two tracks read `manual` while still
              // having none - which the badge could not express at all.
              // "Pending" never appeared, being a state that exists only inside
              // a running import. So the row shows the fact, and the Artists
              // list has an Unknown artist entry for finding them.
              //
              // "Manual" went with them. It means the resolver will not
              // overwrite an edit, which is worth saying once in the dialog
              // that makes the edit rather than on every row forever.
              // The local app reports a track it could not fetch and the server
              // stores it. Shown here because otherwise a song that never
              // reached the iPod looks exactly like one that did.
              track.syncError
                ? h(
                    'span.badge.badge-danger',
                    {
                      title: `Did not sync on ${track.syncFailedOn || 'a paired computer'}: ${track.syncError}`,
                    },
                    'Sync failed'
                  )
                : null
            ),
            // Shown under the title only on a narrow screen, where the artist
            // column itself is hidden. A song list without an artist is not a
            // song list.
            h(
              'div.track-sub.only-narrow',
              track.artistCredit || h('span.subtle', 'Unknown artist')
            ),
            track.trackNo
              ? h(
                  'div.track-sub.not-narrow',
                  `Track ${track.trackNo}${track.discNo && track.discNo > 1 ? ` - Disc ${track.discNo}` : ''}`
                )
              : null
          )
        )
      ),
      h(
        'td.col-artist',
        h('div.cell-truncate', track.artistCredit || h('span.subtle', 'Unknown'))
      ),
      h(
        'td.col-album',
        h('div.cell-truncate', track.albumName || track.albumCredit || h('span.subtle', '--'))
      ),
      h('td.num.col-year', track.releaseYear || '--'),
      h('td.num.col-time', formatDuration(track.durationMs)),
      h(
        'td.actions.shrink',
        h('div.row', { style: { justifyContent: 'flex-end' } },
          h(
            'button.icon-btn',
            {
              type: 'button',
              title: 'Add to playlist',
              'aria-label': `Add ${track.title} to a playlist`,
              onclick: () => addToPlaylistDialog(track),
            },
            icon('list', 16)
          ),
          h(
            'button.icon-btn',
            {
              type: 'button',
              title: 'Edit or re-resolve metadata',
              'aria-label': `Edit ${track.title}`,
              onclick: () => editTrackDialog(track, load),
            },
            icon('settings', 16)
          ),
          h(
            'button.icon-btn.danger',
            {
              type: 'button',
              title: 'Remove from library',
              'aria-label': `Remove ${track.title}`,
              onclick: () => removeTrack(track),
            },
            icon('trash', 16)
          ))
      )
    );
    return row;
  }

  // --- what a selection can do ------------------------------------------
  //
  // Songs, so: put them in a playlist, or take them out of the library. The
  // same two things the per-row buttons offer, which is the point - a selection
  // should not be a different vocabulary.
  function renderSelectionBar() {
    selectionBar([selectionTop, selectionHost], selection, {
      total: lastData.tracks.length,
      onRender: () => renderSelectionBar(),
      // Built per bar rather than shared: one element cannot be in two places,
      // so a shared button would move to whichever bar rendered last.
      actions: [
        () =>
          h(
            'button.btn.btn-sm',
            {
              type: 'button',
              onclick: () => addToPlaylistDialog(selectedTracks()),
            },
            icon('list', 14),
            'Add to playlist'
          ),
        // Offered only when the selection contains something that is actually
        // being flagged. On a list of resolved songs it would do nothing, and a
        // button that does nothing is worse than no button.
        flaggable().length > 0
          ? () =>
              h(
                'button.btn.btn-sm',
                { type: 'button', onclick: () => dismissSelected(true) },
                icon('check', 14),
                'Stop flagging'
              )
          : null,
        dismissed().length > 0
          ? () =>
              h(
                'button.btn.btn-sm',
                { type: 'button', onclick: () => dismissSelected(false) },
                icon('warn', 14),
                'Flag again'
              )
          : null,
        () =>
          h(
            'button.btn.btn-sm.btn-danger',
            { type: 'button', onclick: () => removeSelected() },
            icon('trash', 14),
            'Remove'
          ),
      ].filter(Boolean),
    });
  }

  // Selected tracks the Overview is currently counting, and selected tracks it
  // has been told to stop counting.
  //
  // **The same predicate the server counts on: no artist, not yet accepted.**
  // This asked whether `metadata_state` was unresolved or pending, which is a
  // different set - a song corrected by hand reads `manual` and can still have
  // no artist. One such song sat in "No artist, still flagged" with no Stop
  // flagging button offered, so the one row the filter existed to surface was
  // the one row it could not act on.
  const flaggable = () =>
    selectedTracks().filter(
      (track) => !(track.artistCredit || '').trim() && !track.attentionDismissed
    );
  const dismissed = () => selectedTracks().filter((track) => track.attentionDismissed);

  async function dismissSelected(dismiss) {
    const tracks = dismiss ? flaggable() : dismissed();
    if (tracks.length === 0) return;
    try {
      await api.setAttention(
        tracks.map((track) => track.id),
        dismiss
      );
      selection.clear();
      toast(
        dismiss
          ? `${tracks.length} song${tracks.length === 1 ? '' : 's'} no longer flagged.`
          : `${tracks.length} song${tracks.length === 1 ? '' : 's'} flagged again.`,
        'ok'
      );
      context.refreshStats?.();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function selectedTracks() {
    const wanted = new Set(selection.ids);
    return lastData.tracks.filter((track) => wanted.has(String(track.id)));
  }

  async function removeSelected() {
    const tracks = selectedTracks();
    if (tracks.length === 0) return;

    const confirmed = await confirmDialog({
      title: `Remove ${tracks.length} song${tracks.length === 1 ? '' : 's'}?`,
      message:
        tracks.length === 1
          ? `"${tracks[0].title}" leaves your library, every playlist it is in, and the iPod on the next sync.`
          : `${tracks.length} songs leave your library, every playlist they are in, and the iPod on the next sync.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const { removed } = await api.removeTracks(tracks.map((track) => track.id));
      selection.clear();
      toast(`Removed ${removed} song${removed === 1 ? '' : 's'}.`, 'ok');
      context.refreshStats?.();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeTrack(track) {
    const confirmed = await confirmDialog({
      title: 'Remove from library?',
      message: `"${track.title}" leaves your library, every playlist it is in, and the iPod on the next sync.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await api.removeTrack(track.id);
      toast('Removed from library.', 'ok');
      context.refreshStats();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Takes one track or many. The selection bar and the per-row button want the
  // same dialog, and the only difference is the line naming what is going in.
  async function addToPlaylistDialog(input) {
    const tracks = Array.isArray(input) ? input : [input];
    if (tracks.length === 0) return;
    if (state.playlists.length === 0) {
      toast('Create a playlist first.', 'info');
      return;
    }

    const select = h(
      'select.select',
      state.playlists.map((playlist) =>
        h('option', { value: playlist.id }, `${playlist.name} (${playlist.trackCount})`)
      )
    );

    const control = modal({
      title: 'Add to playlist',
      body: [
        h(
          'p.small.muted',
          tracks.length === 1
            ? tracks[0].title
            : `${tracks.length} songs`
        ),
        field('Playlist', select),
      ],
      footer: [
        h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
        h(
          'button.btn.btn-primary',
          {
            type: 'button',
            onclick: async () => {
              try {
                const result = await api.addToPlaylist(
                  Number(select.value),
                  tracks.map((entry) => entry.id)
                );
                // "Added 3 of 5" matters here: the other two were already in
                // the playlist, which is not a failure but is worth saying.
                toast(
                  result.added === 0
                    ? 'Already in that playlist.'
                    : result.added < result.requested
                      ? `Added ${result.added}; ${result.requested - result.added} were already there.`
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

  function pagination(data) {
    return pager({
      total: data.total,
      limit: state.limit,
      offset: state.offset,
      onChange: ({ limit, offset }) => {
        state.limit = limit;
        state.offset = offset;
        load();
      },
    });
  }

  await load();
}

// ---------------------------------------------------------------------------
// Track editing
// ---------------------------------------------------------------------------

// Manual correction, plus a re-resolve button.
//
// Editing sets metadata_state to 'manual', which the server treats as
// authoritative and will not overwrite automatically. That is a meaningful
// consequence, so the dialog says so rather than leaving it implicit.
export function editTrackDialog(track, onSaved) {
  const title = h('input.input', { type: 'text', value: track.title || '' });
  // Both suggest as you type: names already in this library first, then what
  // Deezer knows. Picking an existing one is what stops the Artists page filling
  // with near-duplicates that differ by a space.
  const artistField = suggestInput({
    value: track.artistCredit || '',
    placeholder: 'Start typing an artist...',
    // A list of names, so suggestions complete the one under the caret rather
    // than replacing the whole field.
    multi: true,
    fetchSuggestions: (q) => api.suggestArtists(q),
  });
  const albumField = suggestInput({
    value: track.albumName || track.albumCredit || '',
    placeholder: 'Start typing an album...',
    fetchSuggestions: (q) => api.suggestAlbums(q),
  });
  const artist = artistField.input;
  const album = albumField.input;
  const trackNo = h('input.input', { type: 'number', min: '0', value: track.trackNo ?? '' });
  const discNo = h('input.input', { type: 'number', min: '0', value: track.discNo ?? '' });

  // The column has existed since the first migration and the local app has
  // always honoured it - the manifest carries it and `downloader.fetch` short
  // circuits its whole search when it is set. There was simply nowhere to type
  // one, so the only way to use it was the API.
  const sourceUrl = h('input.input', {
    type: 'url',
    value: track.sourceHint || '',
    placeholder: 'https://www.youtube.com/watch?v=...',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const statusSlot = h('div');

  const control = modal({
    title: 'Edit metadata',
    body: [
      statusSlot,
      field('Title', title),
      h(
        'div.field',
        h('label', 'Artist'),
        artistField.element,
        h('span.hint', 'Separate several artists with a comma.')
      ),
      field('Album', albumField.element),
      h(
        'div.row',
        field('Track no.', trackNo, { style: { flex: 1 } }),
        field('Disc no.', discNo, { style: { flex: 1 } })
      ),
      h(
        'div.field',
        h('label', 'Audio source link'),
        sourceUrl,
        h('span.hint', 'Optional. Downloads exactly this instead of searching.')
      ),
      h('p.small.subtle', 'Saving marks this track as manually edited, and automatic resolution will leave it alone.'),
    ],
    footer: [
      h(
        'button.btn',
        {
          type: 'button',
          onclick: async () => {
            mount(statusSlot, notice('Searching providers...', 'accent', 'refresh'));
            try {
              const result = await api.resolveTrack(track.id, {
                ignoreIds: true,
                overwriteManual: true,
              });
              if (result.ok) {
                toast('Metadata re-resolved.', 'ok');
                control.close();
                onSaved?.();
              } else {
                mount(
                  statusSlot,
                  notice(
                    result.reason ||
                      result.resolution?.reason ||
                      'No confident match found. Edit the fields by hand instead.',
                    'warn',
                    'warn'
                  )
                );
              }
            } catch (err) {
              mount(statusSlot, notice(err.message, 'danger', 'warn'));
            }
          },
        },
        icon('refresh', 15),
        'Re-resolve'
      ),
      h('div', { style: { flex: 1 } }),
      h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: async () => {
            try {
              await api.updateTrack(track.id, {
                title: title.value.trim(),
                artistCredit: artist.value.trim(),
                albumCredit: album.value.trim(),
                // Empty means "leave it alone" rather than "set to zero", which
                // is why these are null rather than 0 when blank.
                trackNo: trackNo.value === '' ? null : Number(trackNo.value),
                discNo: discNo.value === '' ? null : Number(discNo.value),
                // An empty box means "no link", which is a real edit - so it is
                // sent as an empty string rather than omitted, or clearing a
                // wrong link would be impossible.
                sourceHint: sourceUrl.value.trim(),
              });
              toast('Metadata saved.', 'ok');
              control.close();
              onSaved?.();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Save'
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Hash query string
// ---------------------------------------------------------------------------
//
// The hash carries both the route and its parameters (#/library?state=unresolved),
// so these two functions read and write the part after the '?'.

function readQuery() {
  const hash = window.location.hash;
  const index = hash.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : hash.slice(index + 1));
}

function writeQuery(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.sort && state.sort !== 'added') params.set('sort', state.sort);
  if (state.state) params.set('state', state.state);
  if (state.offset) params.set('offset', String(state.offset));

  const query = params.toString();
  const next = `#/library${query ? `?${query}` : ''}`;
  // replaceState rather than assigning location.hash: this must not fire
  // hashchange, which would re-run the router and rebuild the whole view on
  // every keystroke, nor should filter tweaks fill up the back button.
  if (window.location.hash !== next) {
    history.replaceState(null, '', next);
  }
}
