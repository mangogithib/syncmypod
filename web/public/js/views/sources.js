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

  mount(
    view,
    // No heading here: the page header above already says Sources, and saying
    // it twice is the kind of thing that makes an interface feel unconsidered.
    h(
      'p.page-intro',
      'Playlists this library follows. They are re-read whenever you open this page, and anything new is added. Nothing is ever removed.'
    ),
    addCard(),
    listSlot
  );

  // Names for the platform badges, before the list renders.
  try {
    ({ kinds: platformLabels } = await api.sources());
  } catch {
    // Cosmetic; the raw key is a fine fallback.
  }

  await loadSources();

  // --- adding ---------------------------------------------------------------

  function addCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'Paste a playlist link from any service',
    });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, icon('plus', 15), 'Follow');

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
                const { source } = await api.addSource(url);
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
          h(
            'div.field',
            h('label', 'Playlist link'),
            input,
            h(
              'span.hint',
              'Spotify, Apple Music, YouTube, YouTube Music and Deezer all work, public or unlisted. Copying the address straight out of the browser or an app’s share menu is fine, even if it points at one song inside the playlist.'
            )
          ),
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
              body: 'Paste a playlist link above and this library will keep up with it.',
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
        title: 'Stop following. Tracks already imported are kept.',
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
      h('div.list-actions', h('label.checkbox', { style: { margin: 0 } }, follow), check, remove)
    );
  }

}
