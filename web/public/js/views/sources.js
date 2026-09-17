import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  badge,
  emptyState,
  formatNumber,
  formatRelative,
  notice,
  spinner,
  toast,
} from '../lib/ui.js';

// Sources: the places this library keeps watching.
//
// Everything on the Import page happens once. Paste a link there and you get
// the playlist as it was that afternoon. This page is for the other thing -
// a playlist somebody maintains, followed, so a song added to it turns up here
// without anyone doing anything.
//
// A source is a playlist link from any of the services in
// providers/playlists.js - Spotify, Apple Music, YouTube, YouTube Music,
// Deezer. Public or unlisted, and nothing to sign in to.
//
// There was a connected YouTube account here too, for following the playlists
// in somebody's own account. It is gone: it needed a Google OAuth client
// registered per instance, and then the user's own address added by hand to
// that client's Test users list before it would work at all. A public playlist
// link does the same job and asks for none of it.
//
// Sources are additive. A track removed from a playlist upstream stays in the
// library, and removing a source keeps everything it already brought - the same
// reasoning as the local app never deleting a track it did not add.

// The service a source came from, for the line under its name. Filled from the
// server's own list so it cannot drift from what the readers support.
let platformLabels = {};
function platformLabel(kind) {
  return platformLabels[kind] || kind;
}

export async function renderSources(view, context) {
  const listSlot = h('div');
  // Playlists here, so a source can be pointed at one. Loaded once for the
  // page: every row's dropdown and the add form need the same list.
  let playlists = [];

  mount(view, spinner('Loading sources...'));

  // Both before anything renders: the add form needs the playlist list, and
  // the platform names label every row.
  const [kinds, ownPlaylists] = await Promise.all([
    api.sources().then((data) => data.kinds).catch(() => ({})),
    api.playlists().then((data) => data.playlists).catch(() => []),
  ]);
  if (!context.isCurrent()) return;
  platformLabels = kinds;
  playlists = ownPlaylists;

  mount(view, addCard(), listSlot);
  await loadSources();

  // --- adding ---------------------------------------------------------------

  function addCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'Paste a playlist link',
      'aria-label': 'Playlist link',
    });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, icon('plus', 15), 'Follow');

    // Where its songs should land.
    //
    // The mechanism has always been there - a source remembers a playlist and
    // appends to it on every check - but nothing could choose one, so a source
    // always made its own playlist named after itself. "Keep my Driving
    // playlist in step with that one" was not expressible, which is the main
    // thing anybody wants a source for.
    const target = h(
      'select.select',
      { 'aria-label': 'Add its songs to' },
      h('option', { value: '' }, 'A new playlist named after it')
    );

    for (const playlist of playlists) {
      target.append(h('option', { value: String(playlist.id) }, playlist.name));
    }

    return h(
      'div.card',
      h('div.card-head', h('h2', 'Follow a playlist')),
      h(
        'div.card-body',
        h(
          'form.stack',
          {
            onsubmit: async (event) => {
              event.preventDefault();
              const url = input.value.trim();
              if (!url) {
                toast('Paste a playlist link first.', 'error');
                return;
              }
              submit.disabled = true;
              submit.textContent = 'Reading...';
              try {
                const { source } = await api.addSource(url, target.value || null);
                input.value = '';
                toast(`Now following ${source.name}.`, 'ok');
                await loadSources();
                context?.refreshStats?.();
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                submit.disabled = false;
                mount(submit, icon('plus', 15), 'Follow');
              }
            },
          },
          h('div.field', input),
          h('div.field', h('label', 'Add its songs to'), target),
          h('div', submit)
        )
      )
    );
  }

  // --- the list -------------------------------------------------------------

  async function loadSources() {
    if (!context.isCurrent()) return;
    mount(listSlot, spinner('Loading sources...'));

    let sources;
    try {
      ({ sources } = await api.sources());
    } catch (err) {
      mount(listSlot, notice(err.message, 'danger', 'warn'));
      return;
    }
    if (!context.isCurrent()) return;

    mount(
      listSlot,
      // Inside a card either way. An empty state floating between two cards
      // reads as a gap in the page rather than as one of its parts.
      h(
        'div.card',
        sources.length === 0
          ? emptyState({
              iconName: 'list',
              title: 'Nothing followed yet',
              body: 'A followed playlist is re-read every half hour, and anything new is added.',
            })
          : h('div.list', sources.map(sourceRow))
      )
    );
  }

  function sourceRow(source) {
    const check = h(
      'button.btn.btn-sm',
      {
        type: 'button',
        title: 'Check this source now',
        onclick: async () => {
          check.disabled = true;
          check.textContent = 'Checking...';
          try {
            await api.checkSource(source.id);
            await loadSources();
            context?.refreshStats?.();
          } catch (err) {
            toast(err.message, 'error');
            check.disabled = false;
            check.textContent = 'Check now';
          }
        },
      },
      'Check now'
    );

    const follow = h('input', {
      type: 'checkbox',
      checked: source.enabled,
      title: source.enabled ? 'Following' : 'Paused',
      onchange: async () => {
        try {
          await api.setSourceEnabled(source.id, follow.checked);
        } catch (err) {
          toast(err.message, 'error');
          follow.checked = !follow.checked;
        }
      },
    });

    const remove = h(
      'button.btn.btn-sm.btn-danger',
      {
        type: 'button',
        title: 'Stop following. Songs already imported are kept.',
        onclick: async () => {
          if (
            !window.confirm(
              `Stop following "${source.name}"? Songs it already added stay in your library.`
            )
          ) {
            return;
          }
          try {
            await api.removeSource(source.id);
            toast('Stopped following.', 'ok');
            await loadSources();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      icon('trash', 14)
    );

    // Which playlist here it feeds. Editable in place: pointing a source at a
    // different playlist is the one setting it has, and it is not worth a
    // dialog.
    const target = h(
      'select.select.select-sm',
      {
        'aria-label': `Where ${source.name} adds its songs`,
        onchange: async () => {
          try {
            await api.setSourcePlaylist(source.id, target.value || null);
            toast(
              target.value
                ? `New songs go to ${target.selectedOptions[0].textContent}.`
                : 'New songs go to the library only.',
              'ok'
            );
          } catch (err) {
            toast(err.message, 'error');
            target.value = source.targetPlaylistId ? String(source.targetPlaylistId) : '';
          }
        },
      },
      h('option', { value: '' }, 'Library only'),
      playlists.map((playlist) =>
        h(
          'option',
          {
            value: String(playlist.id),
            selected: String(playlist.id) === String(source.targetPlaylistId),
          },
          playlist.name
        )
      )
    );

    return h(
      'div.list-row',
      artwork(source.artworkUrl, { size: 44 }),
      h(
        'div.list-main',
        h(
          'div.list-title',
          source.name,
          source.enabled ? null : h('span.badge', { style: { marginLeft: '8px' } }, 'Paused')
        ),
        h(
          'div.list-sub',
          [
            platformLabel(source.kind),
            source.lastSeenCount != null
              ? `${formatNumber(source.lastSeenCount)} track${source.lastSeenCount === 1 ? '' : 's'}`
              : null,
            source.lastCheckedAt ? `checked ${formatRelative(source.lastCheckedAt)}` : 'not checked yet',
          ]
            .filter(Boolean)
            .join(' · ')
        ),
        source.lastError ? h('div.small.danger', source.lastError) : null
      ),
      source.lastAdded > 0
        ? badge(`+${formatNumber(source.lastAdded)} new`, 'ok')
        : null,
      h(
        'div.list-actions',
        target,
        h('label.checkbox', { style: { margin: 0 } }, follow),
        check,
        remove
      )
    );
  }

}
