import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  badge,
  confirmDialog,
  debounce,
  emptyState,
  formatRelative,
  modal,
  notice,
  spinner,
  toast,
} from '../lib/ui.js';

// Artists, with the favourite-artist auto-follow controls.
//
// Two lists, because they answer different questions: who is in my library, and
// whose new releases am I watching. An artist can be in either, both or neither.

export async function renderArtists(view, context) {
  const tabs = { current: 'library' };
  const body = h('div');
  const repairSlot = h('div');

  const tabButton = (key, label) =>
    h(
      `button.btn.btn-sm${tabs.current === key ? '.btn-primary' : ''}`,
      {
        type: 'button',
        onclick: () => {
          tabs.current = key;
          render();
        },
      },
      label
    );

  function render() {
    mount(
      view,
      repairSlot,
      h('div.toolbar', tabButton('library', 'In your library'), tabButton('follows', 'Following')),
      body
    );
    if (tabs.current === 'library') {
      renderLibraryArtists();
      offerRepair();
    } else {
      renderFollows();
    }
  }

  // Rows that name several people rather than one artist.
  //
  // iTunes reports every credited artist as one string and gives no structured
  // list, so a track only it knew leaves "Kailash Kher, Naresh Kamath & Paresh
  // Kamath" sitting here as though it were a person. New tracks are expanded as
  // they arrive; this is for anything already stored, or added while Deezer was
  // unreachable.
  //
  // Not a blind split. Each one is checked against a real catalogue, which is
  // why "Earth, Wind & Fire" is still one artist on this page - see
  // services/artist-split.js.
  async function offerRepair() {
    let count = 0;
    try {
      ({ count } = await api.combinedArtistCount());
    } catch {
      return; // Informational; never break the page over it.
    }
    if (!context.isCurrent() || count === 0) {
      mount(repairSlot);
      return;
    }

    const run = h(
      'button.btn.btn-sm.btn-primary',
      {
        type: 'button',
        onclick: async () => {
          run.disabled = true;
          run.textContent = 'Checking...';
          try {
            const report = await api.repairCombinedArtists();
            toast(
              report.split > 0
                ? `Separated ${report.split}. ${report.left} could not be confirmed and were left alone.`
                : 'Nothing could be confirmed, so nothing was changed.',
              report.split > 0 ? 'ok' : 'info'
            );
            render();
          } catch (err) {
            toast(err.message, 'error');
            run.disabled = false;
            run.textContent = 'Separate them';
          }
        },
      },
      'Separate them'
    );

    mount(
      repairSlot,
      notice(
        h(
          'div.row-between',
          h(
            'div',
            h('strong', `${count} entr${count === 1 ? 'y names' : 'ies name'} more than one artist. `),
            h(
              'span',
              'They came from a source that reports every credit as one string. Each one is checked against a real catalogue before being separated, so a band with an ampersand in its name is left alone.'
            )
          ),
          run
        ),
        '',
        'info'
      )
    );
  }

  // --- artists in the library ---------------------------------------------

  async function renderLibraryArtists() {
    const listSlot = h('div');
    const searchBox = h('input.input', {
      type: 'search',
      placeholder: 'Search artists...',
      'aria-label': 'Search artists',
    });

    let q = '';
    searchBox.addEventListener(
      'input',
      debounce(() => {
        q = searchBox.value.trim();
        load();
      })
    );

    mount(body, h('div.toolbar', h('div.search-input', icon('search', 15), searchBox)), listSlot);

    async function load() {
      mount(listSlot, spinner('Loading artists...'));
      try {
        const data = await api.artists({ q, limit: 200 });
        if (!context.isCurrent()) return;

        if (data.total === 0) {
          mount(
            listSlot,
            emptyState({
              iconName: 'user',
              title: q ? 'No artists match' : 'No artists yet',
              body: q ? 'Try a different search.' : 'Artists appear here as you add songs.',
            })
          );
          return;
        }

        mount(
          listSlot,
          h(
            'div.card',
            h(
              'div.list',
              data.artists.map((artist) =>
                h(
                  'div.list-row',
                  artwork(artist.imageUrl, { size: 38 }),
                  h(
                    'div.list-main',
                    h('div.list-title', artist.name),
                    h(
                      'div.list-sub',
                      `${artist.trackCount} song${artist.trackCount === 1 ? '' : 's'}`,
                      artist.albumCount ? ` - ${artist.albumCount} album${artist.albumCount === 1 ? '' : 's'}` : ''
                    )
                  ),
                  h(
                    'div.list-actions',
                    artist.followed ? badge('Following', 'accent') : null,
                    h(
                      'a.btn.btn-sm',
                      { href: `#/library?q=${encodeURIComponent(artist.name)}` },
                      'Songs'
                    ),
                    artist.followed
                      ? h(
                          'button.btn.btn-sm',
                          { type: 'button', onclick: () => unfollow(artist, load) },
                          'Unfollow'
                        )
                      : h(
                          'button.btn.btn-sm',
                          {
                            type: 'button',
                            disabled: !artist.deezerId,
                            title: artist.deezerId
                              ? 'Watch for new releases'
                              : 'This artist has no Deezer id, so new releases cannot be tracked',
                            onclick: () => followDialog(artist, load),
                          },
                          'Follow'
                        )
                  )
                )
              )
            )
          )
        );
      } catch (err) {
        if (err.status === 401) return;
        mount(listSlot, notice(err.message, 'danger', 'warn'));
      }
    }

    await load();
  }

  // --- followed artists ----------------------------------------------------

  async function renderFollows() {
    mount(body, spinner('Loading follows...'));
    try {
      const [{ follows, discoveryEnabled }, { playlists }] = await Promise.all([
        api.follows(),
        api.playlists().catch(() => ({ playlists: [] })),
      ]);
      if (!context.isCurrent()) return;

      const blocks = [];

      // Release discovery needs Deezer. Without it, follows can be
      // recorded but nothing will ever be found, so say that up front rather
      // than letting someone wonder why nothing arrives.
      if (!discoveryEnabled) {
        blocks.push(
          notice(
            h(
              'div',
              h('strong', 'Deezer is switched off. '),
              h('span', 'New releases cannot be discovered until it is. '),
              h('a', { href: '#/settings' }, 'How to set it up')
            ),
            'warn',
            'warn'
          )
        );
      }

      // There is no bulk "import everyone I follow" any more: that needed a
      // user's account on a streaming service, and none of the current
      // providers exposes a follow list without one. Artists are followed
      // individually from a search result instead.
      blocks.push(
        h(
          'div.toolbar',
          h('div', { style: { flex: 1 } }),
          h('a.btn.btn-primary', { href: '#/search' }, icon('search', 15), 'Find an artist')
        )
      );

      if (follows.length === 0) {
        blocks.push(
          emptyState({
            iconName: 'heart',
            title: 'Not following anyone yet',
            body:
              'Follow an artist and their new releases are added to your library automatically. Following never pulls in their back catalogue.',
            action: h('a.btn.btn-primary', { href: '#/search' }, 'Find an artist'),
          })
        );
      } else {
        blocks.push(
          h(
            'div.card',
            h(
              'div.list',
              follows.map((follow) => followRow(follow, playlists))
            )
          )
        );
      }

      mount(body, blocks);
    } catch (err) {
      if (err.status === 401) return;
      mount(body, notice(err.message, 'danger', 'warn'));
    }
  }

  function followRow(follow, playlists) {
    return h(
      'div.list-row',
      artwork(follow.imageUrl, { size: 38 }),
      h(
        'div.list-main',
        h('div.list-title', follow.name),
        h(
          'div.list-sub',
          [
            `${follow.trackCount} song${follow.trackCount === 1 ? '' : 's'} in library`,
            follow.autoAdd ? 'auto-adding' : 'watching only',
            follow.includeSingles ? 'incl. singles' : 'albums only',
            follow.targetPlaylistName ? `to "${follow.targetPlaylistName}"` : null,
          ]
            .filter(Boolean)
            .join(' - ')
        ),
        h('div.small.subtle', `Last checked ${formatRelative(follow.lastCheckedAt)}`)
      ),
      h(
        'div.list-actions',
        h(
          'button.btn.btn-sm',
          { type: 'button', onclick: () => checkNow(follow) },
          icon('refresh', 14),
          'Check now'
        ),
        h(
          'button.btn.btn-sm',
          { type: 'button', onclick: () => followDialog(follow, renderFollows, playlists) },
          'Options'
        ),
        h(
          'button.icon-btn.danger',
          {
            type: 'button',
            title: 'Unfollow',
            'aria-label': `Unfollow ${follow.name}`,
            onclick: () => unfollow(follow, renderFollows),
          },
          icon('trash', 16)
        )
      )
    );
  }

  async function checkNow(follow) {
    toast(`Checking ${follow.name}...`, 'info', 2000);
    try {
      const result = await api.checkFollow(follow.id);
      if (!result.checked) {
        toast(result.reason || 'Could not check right now.', 'error');
        return;
      }
      const found = result.newReleases?.length || 0;
      if (found === 0) {
        toast(`No new releases from ${follow.name}.`, 'ok');
      } else if (result.added > 0) {
        toast(`Added ${result.added} track(s) from ${found} new release(s).`, 'ok');
        context.refreshStats();
      } else {
        toast(
          `${found} new release(s) found. Auto-add is off, so nothing was added.`,
          'info'
        );
      }
      renderFollows();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function unfollow(artist, onDone) {
    const confirmed = await confirmDialog({
      title: 'Unfollow artist?',
      message: `New releases from ${artist.name} will no longer be added automatically. Songs already in your library stay.`,
      confirmLabel: 'Unfollow',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.unfollow(artist.id);
      toast(`Unfollowed ${artist.name}.`, 'ok');
      onDone?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  render();
}

// The follow options dialog. Shared by the search results page, which is why it
// is exported and takes a loose artist shape rather than a library row.
export function followDialog(artist, onSaved, playlists) {
  const autoAdd = h('input', { type: 'checkbox', checked: artist.autoAdd ?? true });
  const singles = h('input', { type: 'checkbox', checked: artist.includeSingles ?? true });
  const compilations = h('input', {
    type: 'checkbox',
    checked: artist.includeCompilations ?? false,
  });
  // Off by default. Following someone is a small commitment; pulling in twenty
  // years of back catalogue is not, and it should be asked for rather than
  // assumed.
  const importExisting = h('input', { type: 'checkbox' });

  const playlistSelect = h(
    'select.select',
    h('option', { value: '' }, 'Library only (no playlist)'),
    (playlists || []).map((playlist) =>
      h(
        'option',
        { value: playlist.id, selected: playlist.id === artist.targetPlaylistId },
        playlist.name
      )
    )
  );

  const control = modal({
    title: `Follow ${artist.name}`,
    body: [
      h(
        'label.checkbox',
        autoAdd,
        h(
          'span',
          h('div', 'Add new releases automatically'),
          h('div.small.subtle', 'Off means they are recorded but nothing is added to your library.')
        )
      ),
      h('label.checkbox', singles, h('span', 'Include singles and EPs')),
      h('label.checkbox', compilations, h('span', 'Include compilations')),
      h(
        'label.checkbox',
        importExisting,
        h(
          'span',
          h('div', 'Also import everything released so far'),
          h(
            'div.small.subtle',
            'Adds the existing catalogue, not only future releases. This runs in the background and can take a few minutes.'
          )
        )
      ),
      playlists
        ? h(
            'div.field',
            h('label', 'Also add to playlist'),
            playlistSelect,
            h('span.hint', 'New tracks are appended to this playlist as well as the library.')
          )
        : null,
      notice(
        'Following starts from today unless you ask for the back catalogue above. Existing releases are otherwise recorded as already seen.',
        '',
        'info'
      ),
      !artist.deezerId
        ? notice(
            'This artist has no Deezer id, so new releases cannot be discovered.',
            'warn',
            'warn'
          )
        : null,
    ],
    footer: [
      h('button.btn', { type: 'button', onclick: () => control.close() }, 'Cancel'),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: async () => {
            try {
              await api.follow({
                // A library artist carries a catalogue id; a provider search
                // result has only provider identity. The server
                // accepts either, creating the artist row when needed.
                artistId: artist.id,
                name: artist.name,
                deezerId: artist.deezerId,
                itunesId: artist.itunesId,
                mbid: artist.mbid,
                autoAdd: autoAdd.checked,
                includeSingles: singles.checked,
                includeCompilations: compilations.checked,
                targetPlaylistId: playlistSelect.value ? Number(playlistSelect.value) : null,
                importExisting: importExisting.checked,
              });
              if (importExisting.checked) {
                toast(
                  `Following ${artist.name}. Importing their catalogue in the background.`,
                  'ok'
                );
              } else {
                toast(`Following ${artist.name}.`, 'ok');
              }
              control.close();
              onSaved?.();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Follow'
      ),
    ],
  });
}
