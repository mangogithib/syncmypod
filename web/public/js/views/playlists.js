import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { createSelection, selectable, selectAllRow, selectionBar } from '../lib/select.js';
import {
  artwork,
  confirmDialog,
  emptyState,
  formatDuration,
  formatTotalDuration,
  modal,
  notice,
  renderAsync,
  toast,
} from '../lib/ui.js';

// Playlists: the list, and the detail view with reordering.

export async function renderPlaylists(view, context) {
  context.setActions(
    h(
      'button.btn.btn-primary.btn-sm',
      { type: 'button', onclick: () => createPlaylistDialog(() => renderPlaylists(view, context)) },
      icon('plus', 15),
      'New playlist'
    )
  );

  await renderAsync(
    view,
    () => api.playlists(),
    ({ playlists }) => {
      if (playlists.length === 0) {
        return emptyState({
          iconName: 'list',
          title: 'No playlists yet',
          body:
            'Playlists sync to the iPod as real playlists. Create one here, or import one.',
          action: h(
            'div.row',
            { style: { justifyContent: 'center' } },
            h(
              'button.btn.btn-primary',
              { type: 'button', onclick: () => createPlaylistDialog(() => renderPlaylists(view, context)) },
              'New playlist'
            ),
            h('a.btn', { href: '#/import' }, 'Import a playlist')
          ),
        });
      }

      return h(
        'div.card',
        h(
          'div.list',
          playlists.map((playlist) =>
            h(
              'div.list-row',
              artwork(playlist.artworkUrl, { size: 42 }),
              h(
                'div.list-main',
                h(
                  'a.list-title',
                  { href: `#/playlists/${playlist.id}`, style: { color: 'inherit' } },
                  playlist.name
                ),
                h(
                  'div.list-sub',
                  [
                    `${playlist.trackCount} song${playlist.trackCount === 1 ? '' : 's'}`,
                    playlist.durationMs ? formatTotalDuration(playlist.durationMs) : null,
                    playlist.source === 'deezer' ? 'from Deezer' : null,
                  ]
                    .filter(Boolean)
                    .join(' - ')
                )
              ),
              h(
                'div.list-actions',
                !playlist.syncToIpod ? h('span.badge.badge-warn', 'Not syncing') : null,
                h('a.btn.btn-sm', { href: `#/playlists/${playlist.id}` }, 'Open')
              )
            )
          )
        )
      );
    }
  );
}

export async function renderPlaylist(view, context) {
  const playlistId = Number(context.params.id);
  if (!Number.isInteger(playlistId)) {
    mount(view, notice('That is not a valid playlist.', 'danger', 'warn'));
    return;
  }

  context.setActions(
    h('a.btn.btn-sm', { href: '#/playlists' }, icon('back', 15), 'All playlists')
  );

  await load();

  async function load() {
    await renderAsync(
      view,
      () => api.playlist(playlistId),
      (playlist) => {
        context.setTitle(playlist.name);

        // Held locally so a drag or a move button can reorder immediately and
        // persist afterwards, rather than waiting for a round trip per nudge.
        let order = playlist.tracks.map((track) => track.id);
        const byId = new Map(playlist.tracks.map((track) => [track.id, track]));

        const listSlot = h('div.list');
        // Two hosts, one above the list and one below it. A selection made at
        // the foot of a three-hundred-song playlist should not need a scroll
        // back to the top to act on, and the reverse is just as true.
        const selectionTop = h('div', { hidden: true });
        const selectionHost = h('div', { hidden: true });
        const orphaned = playlist.tracks.filter((track) => !track.inLibrary);

        const selection = createSelection({ onChange: () => paintSelectionBar() });

        // Three things worth doing to a handful of tracks in a playlist, and
        // they are genuinely different: take them out of this playlist, put
        // them in another one as well, or remove them from the library
        // altogether - which takes them out of every playlist and off the iPod.
        //
        // Actions are built per bar rather than shared: one element cannot be
        // in two places, so a shared button would simply move to whichever bar
        // rendered last.
        function paintSelectionBar() {
          const chosen = selection.ids.map(Number);
          selectionBar([selectionTop, selectionHost], selection, {
            total: order.length,
            onRender: () => paintSelectionBar(),
            actions: [
              () =>
                h(
                  'button.btn.btn-sm',
                  { type: 'button', onclick: () => removeSelectedFromPlaylist(chosen) },
                  icon('x', 14),
                  'Remove from playlist'
                ),
              () =>
                h(
                  'button.btn.btn-sm.btn-danger',
                  { type: 'button', onclick: () => removeSelectedFromLibrary(chosen) },
                  icon('trash', 14),
                  'Remove from library'
                ),
            ],
          });
        }

        async function removeSelectedFromPlaylist(trackIds) {
          if (trackIds.length === 0) return;
          try {
            const { removed } = await api.removeManyFromPlaylist(playlistId, trackIds);
            const gone = new Set(trackIds);
            order = order.filter((value) => !gone.has(value));
            for (const trackId of gone) byId.delete(trackId);
            selection.clear();
            paintList();
            toast(`Removed ${removed} from the playlist.`, 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        }

        async function removeSelectedFromLibrary(trackIds) {
          if (trackIds.length === 0) return;
          const confirmed = await confirmDialog({
            title: `Remove ${trackIds.length} song${trackIds.length === 1 ? '' : 's'} from the library?`,
            message:
              'They leave your library, every playlist they are in, and the iPod on the next sync. This is not the same as taking them out of this playlist.',
            confirmLabel: 'Remove from library',
            danger: true,
          });
          if (!confirmed) return;
          try {
            const { removed } = await api.removeTracks(trackIds);
            const gone = new Set(trackIds);
            order = order.filter((value) => !gone.has(value));
            for (const trackId of gone) byId.delete(trackId);
            selection.clear();
            paintList();
            toast(`Removed ${removed} from your library.`, 'ok');
            context.refreshStats?.();
          } catch (err) {
            toast(err.message, 'error');
          }
        }

        const persistOrder = async () => {
          try {
            await api.reorderPlaylist(playlistId, order);
          } catch (err) {
            toast(`Could not save the new order: ${err.message}`, 'error');
            load();
          }
        };

        const move = (trackId, delta) => {
          const index = order.indexOf(trackId);
          const target = index + delta;
          if (index === -1 || target < 0 || target >= order.length) return;
          order.splice(index, 1);
          order.splice(target, 0, trackId);
          paintList();
          persistOrder();
        };

        let dragId = null;

        function paintList() {
          selection.setOrder(order);
          selection.resetRows();
          mount(
            listSlot,
            order.map((trackId, index) => {
              const track = byId.get(trackId);
              if (!track) return null;

              const row = h('div.list-row', {
                draggable: 'true',
                dataset: { trackId: String(trackId) },
              });
              // Long-press selection and drag-to-reorder do not fight on touch:
              // dragging here is a mouse shortcut, and the move buttons are how
              // a finger reorders. See `select.js`.
              const check = selectable(row, trackId, selection);

              row.append(
                h('span.check-cell', check),
                h('span.drag-handle', { 'aria-hidden': 'true' }, icon('grip', 16)),
                h('span.small.subtle', { style: { width: '26px', textAlign: 'right' } }, String(index + 1)),
                artwork(track.artworkUrl, { size: 34 }),
                h(
                  'div.list-main',
                  h('div.list-title', track.title),
                  h('div.list-sub', track.artistCredit || 'Unknown artist')
                ),
                h('span.small.subtle.nowrap', formatDuration(track.durationMs)),
                // "Not in library" stays: it means this row will be skipped
                // when syncing, which is about the playlist rather than about
                // the song's metadata. The metadata badge is gone for the same
                // reason it went from the Songs list - see library.js.
                !track.inLibrary ? h('span.badge.badge-warn', 'Not in library') : null,
                h(
                  'div.list-actions',
                  // Keyboard-accessible ordering. Dragging is the shortcut, not
                  // the only way - a list you cannot reorder without a mouse is
                  // a list some people simply cannot reorder.
                  h(
                    'button.icon-btn',
                    {
                      type: 'button',
                      title: 'Move up',
                      'aria-label': `Move ${track.title} up`,
                      disabled: index === 0,
                      onclick: () => move(trackId, -1),
                    },
                    icon('up', 15)
                  ),
                  h(
                    'button.icon-btn',
                    {
                      type: 'button',
                      title: 'Move down',
                      'aria-label': `Move ${track.title} down`,
                      disabled: index === order.length - 1,
                      onclick: () => move(trackId, 1),
                    },
                    icon('down', 15)
                  ),
                  h(
                    'button.icon-btn.danger',
                    {
                      type: 'button',
                      title: 'Remove from playlist',
                      'aria-label': `Remove ${track.title} from this playlist`,
                      onclick: async () => {
                        try {
                          await api.removeFromPlaylist(playlistId, trackId);
                          order = order.filter((value) => value !== trackId);
                          byId.delete(trackId);
                          paintList();
                          toast('Removed from playlist.', 'ok');
                        } catch (err) {
                          toast(err.message, 'error');
                        }
                      },
                    },
                    icon('trash', 15)
                  )
                )
              );

              row.addEventListener('dragstart', (event) => {
                dragId = trackId;
                row.classList.add('dragging');
                event.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without data set on it.
                event.dataTransfer.setData('text/plain', String(trackId));
              });
              row.addEventListener('dragend', () => {
                dragId = null;
                row.classList.remove('dragging');
                listSlot.querySelectorAll('.drop-target').forEach((el) =>
                  el.classList.remove('drop-target')
                );
              });
              row.addEventListener('dragover', (event) => {
                if (dragId === null || dragId === trackId) return;
                event.preventDefault();
                row.classList.add('drop-target');
              });
              row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
              row.addEventListener('drop', (event) => {
                event.preventDefault();
                row.classList.remove('drop-target');
                if (dragId === null || dragId === trackId) return;

                const from = order.indexOf(dragId);
                const to = order.indexOf(trackId);
                if (from === -1 || to === -1) return;
                order.splice(from, 1);
                order.splice(to, 0, dragId);
                paintList();
                persistOrder();
              });

              return row;
            })
          );
        }

        paintList();

        const blocks = [];

        if (orphaned.length > 0) {
          // An import can leave playlist entries for tracks later
          // removed from the library. They are excluded from the sync manifest,
          // so flagging them explains a count that would otherwise look wrong.
          blocks.push(
            notice(
              `${orphaned.length} track${orphaned.length === 1 ? '' : 's'} no longer in your library, so ${orphaned.length === 1 ? 'it is' : 'they are'} skipped when syncing.`,
              'warn',
              'warn'
            )
          );
        }

        if (!playlist.syncToIpod) {
          blocks.push(
            notice('This playlist is set not to sync to the iPod.', 'warn', 'info')
          );
        }

        blocks.push(
          h(
            'div.toolbar',
            h(
              'div',
              h('div', { style: { fontWeight: 600, fontSize: '18px' } }, playlist.name),
              h(
                'div.small.muted',
                [
                  `${playlist.tracks.length} song${playlist.tracks.length === 1 ? '' : 's'}`,
                  playlist.description || null,
                  playlist.source === 'deezer' ? 'imported from Deezer' : null,
                ]
                  .filter(Boolean)
                  .join(' - ')
              )
            ),
            h('div', { style: { flex: 1 } }),
            h(
              'button.btn.btn-sm',
              { type: 'button', onclick: () => editPlaylistDialog(playlist, load) },
              'Settings'
            ),
            h('a.btn.btn-sm.btn-primary', { href: '#/search' }, icon('plus', 14), 'Add songs')
          )
        );

        if (playlist.tracks.length === 0) {
          blocks.push(
            emptyState({
              iconName: 'music',
              title: 'This playlist is empty',
              body: 'Add songs from your library, or search for new ones.',
              action: h('a.btn.btn-primary', { href: '#/library' }, 'Browse library'),
            })
          );
        } else {
          blocks.push(
            selectionTop,
            h(
              'div.card',
              selectAllRow(selection, {
                total: order.length,
                label: 'Select every song in this playlist',
              }),
              listSlot
            ),
            selectionHost
          );
        }

        return blocks;
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function createPlaylistDialog(onCreated) {
  const name = h('input.input', { type: 'text', placeholder: 'Morning drive' });
  const description = h('textarea.textarea', { placeholder: 'Optional' });
  const sync = h('input', { type: 'checkbox', checked: true });

  const control = modal({
    title: 'New playlist',
    body: [
      h('div.field', h('label', 'Name'), name),
      h('div.field', h('label', 'Description'), description),
      h(
        'label.checkbox',
        sync,
        h('span', 'Sync this playlist to the iPod')
      ),
    ],
    footer: [
      h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: async () => {
            const value = name.value.trim();
            if (!value) {
              toast('Give the playlist a name.', 'error');
              name.focus();
              return;
            }
            try {
              await api.createPlaylist({
                name: value,
                description: description.value.trim() || undefined,
                syncToIpod: sync.checked,
              });
              toast('Playlist created.', 'ok');
              control.close();
              onCreated?.();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Create'
      ),
    ],
  });
}

function editPlaylistDialog(playlist, onSaved) {
  const name = h('input.input', { type: 'text', value: playlist.name });
  const description = h('textarea.textarea', { value: playlist.description || '' });
  const sync = h('input', { type: 'checkbox', checked: playlist.syncToIpod });

  const control = modal({
    title: 'Playlist settings',
    body: [
      h('div.field', h('label', 'Name'), name),
      h('div.field', h('label', 'Description'), description),
      h(
        'label.checkbox',
        sync,
        h(
          'span',
          h('div', 'Sync this playlist to the iPod'),
          h('div.small.subtle', 'Turn off to keep it in the web library only.')
        )
      ),
    ],
    footer: [
      h(
        'button.btn.btn-danger',
        {
          type: 'button',
          onclick: async () => {
            control.close();
            const confirmed = await confirmDialog({
              title: 'Delete playlist?',
              message: `"${playlist.name}" will be deleted. The songs stay in your library.`,
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!confirmed) return;
            try {
              await api.deletePlaylist(playlist.id);
              toast('Playlist deleted.', 'ok');
              window.location.hash = '#/playlists';
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Delete'
      ),
      h('div', { style: { flex: 1 } }),
      h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: async () => {
            try {
              await api.updatePlaylist(playlist.id, {
                name: name.value.trim(),
                description: description.value.trim(),
                syncToIpod: sync.checked,
              });
              toast('Saved.', 'ok');
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
