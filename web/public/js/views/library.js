import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  confirmDialog,
  debounce,
  emptyState,
  formatDuration,
  formatNumber,
  metadataBadge,
  modal,
  notice,
  spinner,
  toast,
} from '../lib/ui.js';

// The songs table: search, filter, sort, page, and per-track actions.
//
// Filter and sort state lives in the URL hash query string, so a filtered view
// can be linked to and survives a reload. The dashboard links straight to
// #/library?state=unresolved on the strength of that.

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
      'aria-label': 'Filter by metadata state',
      onchange: () => {
        state.state = stateFilter.value;
        state.offset = 0;
        load();
      },
    },
    h('option', { value: '' }, 'All songs'),
    h('option', { value: 'resolved' }, 'Resolved only'),
    h('option', { value: 'unresolved' }, 'Unresolved'),
    h('option', { value: 'pending' }, 'Pending'),
    h('option', { value: 'manual' }, 'Manually edited')
  );
  stateFilter.value = state.state;

  offerRematch();

  // Songs with a title and nothing else, offered another go.
  //
  // These were close to unmatchable before YouTube Music: a title on its own is
  // not enough to identify a recording, so they were stored honestly empty and
  // left for a human. YouTube Music answers with a real artist, which usually
  // makes them resolvable - so the work a person would have had to do by hand
  // is worth trying automatically first.
  async function offerRematch() {
    let count = 0;
    try {
      ({ count } = await api.unresolvedCount());
    } catch {
      return; // Informational; never break the page over it.
    }
    if (!context.isCurrent() || count === 0) {
      mount(rematchSlot);
      return;
    }

    const run = h(
      'button.btn.btn-sm.btn-primary',
      { type: 'button', onclick: () => startRematch(run) },
      'Look them up'
    );

    mount(
      rematchSlot,
      notice(
        h(
          'div.row-between',
          h(
            'div',
            h(
              'strong',
              `${formatNumber(count)} song${count === 1 ? ' has' : 's have'} no artist yet. `
            ),
            h(
              'span',
              'They arrived with a title and nothing else, so they will not sync. YouTube Music can usually identify them now.'
            )
          ),
          run
        ),
        '',
        'info'
      )
    );
  }

  async function startRematch(button) {
    button.disabled = true;
    button.textContent = 'Looking up...';
    try {
      const { jobId, total } = await api.rematchUnresolved();
      watchRematch(jobId, total);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = 'Look them up';
    }
  }

  // The same shape the importers use: the server works in the background and
  // this polls, so closing the dialog does not stop it.
  function watchRematch(jobId, total) {
    const bar = h('div.progress-bar', { style: { width: '0%' } });
    const line = h('p.muted', 'Starting...');
    const detail = h('div');

    let stopped = false;

    modal({
      title: 'Looking up songs with no artist',
      // Closing stops the polling, not the work. The pass carries on
      // server-side, same as an import.
      onClose: () => {
        stopped = true;
      },
      body: [
        line,
        h('div.progress', bar),
        detail,
        notice(
          'Each song is looked up on YouTube Music and then checked against a real catalogue. Anything still unrecognised is left exactly as it was.',
          '',
          'info'
        ),
      ],
    });

    const poll = async () => {
      if (stopped) return;
      try {
        const job = await api.importJob(jobId);
        const percent = total > 0 ? Math.round((job.processed / total) * 100) : 0;
        bar.style.width = `${percent}%`;

        if (job.status === 'done') {
          line.textContent =
            job.added > 0
              ? `Identified ${formatNumber(job.added)} of ${formatNumber(job.processed)}. ${formatNumber(job.skipped)} still unknown.`
              : `None of the ${formatNumber(job.processed)} could be identified. They are unchanged.`;
          if (job.report?.length) {
            mount(
              detail,
              h(
                'div.card',
                { style: { marginTop: '12px', maxHeight: '260px', overflowY: 'auto' } },
                h(
                  'div.list',
                  job.report.map((entry) =>
                    h(
                      'div.list-row',
                      { style: { padding: '8px 12px' } },
                      h(
                        'div.list-main',
                        h('div.small.subtle', entry.title),
                        h('div.small', { style: { fontWeight: 500 } }, entry.reason)
                      )
                    )
                  )
                )
              )
            );
          }
          stopped = true;
          load();
          offerRematch();
          context?.refreshStats?.();
          return;
        }

        if (job.status === 'error') {
          line.textContent = job.error || 'That stopped with an error.';
          stopped = true;
          return;
        }

        line.textContent = `${formatNumber(job.processed)} of ${formatNumber(total)} checked, ${formatNumber(job.added)} identified...`;
      } catch {
        // A dropped poll is not a failed job.
      }
      setTimeout(poll, 1200);
    };
    poll();
  }

  const onSearch = debounce(() => {
    state.q = searchBox.value.trim();
    state.offset = 0;
    load();
  });
  searchBox.addEventListener('input', onSearch);

  // Offered only when there is something to offer it for, and it disappears
  // once there is not. A button that is permanently there and usually does
  // nothing teaches people to ignore it.
  const rematchSlot = h('div');

  mount(
    view,
    rematchSlot,
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
    results
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
      mount(results, renderTable(data));
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
        body:
          state.q || state.state
            ? 'Try a different search, or clear the filter.'
            : 'Search for songs to add, or import a list of tracks.',
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
              sortHeader('Title', 'title'),
              sortHeader('Artist', 'artist', '.col-artist'),
              // Classed so a phone can drop them. Title, artist and the row
              // actions are what a song list is for; a year and a running time
              // are not worth a sideways scroll on a 390px screen.
              sortHeader('Album', 'album', '.col-album'),
              sortHeader('Year', 'year', '.right.col-year'),
              sortHeader('Time', 'duration', '.right.col-time'),
              h('th.col-meta', 'Metadata'),
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
    const row = h(
      'tr',
      h(
        'td',
        h(
          'div.track-cell',
          artwork(track.artworkUrl, { size: 36 }),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div.track-title', track.title),
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
      h('td.shrink.col-meta', metadataBadge(track.metadataState)),
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

  async function removeTrack(track) {
    const confirmed = await confirmDialog({
      title: 'Remove from library?',
      message: `"${track.title}" will be removed from your library and from any playlist it is in. It will also be removed from the iPod on the next sync.`,
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

  async function addToPlaylistDialog(track) {
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
        h('p.small.muted', track.title),
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
                const result = await api.addToPlaylist(Number(select.value), [track.id]);
                toast(
                  result.added > 0 ? 'Added to playlist.' : 'Already in that playlist.',
                  result.added > 0 ? 'ok' : 'info'
                );
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

  function pagination(data) {
    const from = data.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, data.total);

    return h(
      'div.pagination',
      h('span', `${formatNumber(from)}-${formatNumber(to)} of ${formatNumber(data.total)}`),
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
            disabled: to >= data.total,
            onclick: () => {
              state.offset += state.limit;
              load();
            },
          },
          'Next'
        )
      )
    );
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
  const artist = h('input.input', { type: 'text', value: track.artistCredit || '' });
  const album = h('input.input', { type: 'text', value: track.albumName || track.albumCredit || '' });
  const trackNo = h('input.input', { type: 'number', min: '0', value: track.trackNo ?? '' });
  const discNo = h('input.input', { type: 'number', min: '0', value: track.discNo ?? '' });

  const statusSlot = h('div');

  const control = modal({
    title: 'Edit metadata',
    body: [
      statusSlot,
      h('div.field', h('label', 'Title'), title),
      h(
        'div.field',
        h('label', 'Artist'),
        artist,
        h('span.hint', 'Multiple artists are joined with a comma. This is what gets written to the iPod tag.')
      ),
      h('div.field', h('label', 'Album'), album),
      h(
        'div.row',
        h('div.field', { style: { flex: 1 } }, h('label', 'Track no.'), trackNo),
        h('div.field', { style: { flex: 1 } }, h('label', 'Disc no.'), discNo)
      ),
      notice(
        'Saving marks this track as manually edited. Automatic resolution will then leave it alone.',
        '',
        'info'
      ),
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
