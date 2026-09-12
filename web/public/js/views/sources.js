import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  artwork,
  badge,
  emptyState,
  formatNumber,
  formatRelative,
  modal,
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
// Two kinds live here:
//
//   * A playlist link. YouTube or Deezer, public. Nothing to sign in to.
//   * A connected YouTube account, whose own playlists can be followed the same
//     way. This is the only part of the application that needs credentials.
//
// Sources are additive. A track removed from a playlist upstream stays in the
// library, and removing a source keeps everything it already brought - the same
// reasoning as the local app never deleting a track it did not add.

export async function renderSources(view, context) {
  const listSlot = h('div');
  const accountSlot = h('div');

  mount(
    view,
    // No heading here: the page header above already says Sources, and saying
    // it twice is the kind of thing that makes an interface feel unconsidered.
    h(
      'p.page-intro',
      'Playlists this library follows. They are re-read whenever you open this page, and anything new is added. Nothing is ever removed.'
    ),
    addCard(),
    listSlot,
    accountSlot
  );

  await Promise.all([loadSources(), loadAccount()]);

  // --- adding ---------------------------------------------------------------

  function addCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'https://www.youtube.com/playlist?list=...  or  https://www.deezer.com/playlist/...',
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
              'YouTube and Deezer playlists both work, public or unlisted. Copying the address straight out of the browser is fine, even if it points at one song inside the playlist.'
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
            source.kind === 'youtube-playlist' ? 'YouTube' : 'Deezer',
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

  // --- the connected account ------------------------------------------------

  async function loadAccount() {
    if (!context.isCurrent()) return;

    let state;
    try {
      state = await api.youtubeAccount();
    } catch (err) {
      mount(accountSlot, notice(err.message, 'danger', 'warn'));
      return;
    }
    if (!context.isCurrent()) return;

    mount(
      accountSlot,
      state.connected ? connectedCard(state) : setupCard(state)
    );
  }

  // Not connected.
  //
  // One button, and nothing else. The five steps for registering a Google
  // client used to be on this card, folded away but still present, and they
  // made a page about following playlists look like a page about Google Cloud.
  // They live in Settings now, next to the two fields they tell you to fill in,
  // which is where somebody acting on them needs to be anyway.
  function setupCard(state) {
    const connect = h(
      'button.btn.btn-primary',
      { type: 'button', onclick: () => (state.configured ? startConnect(connect) : explainSetup()) },
      icon('link', 15),
      'Connect YouTube account'
    );

    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Your YouTube account'),
        h('div.spacer'),
        state.configured ? badge('Ready to connect', 'ok') : badge('Setup needed', 'warn')
      ),
      h(
        'div.card-body',
        h(
          'p.muted',
          'Follow the playlists in your own YouTube account, including liked songs. Read-only: this can list your playlists and what is in them, and nothing else. It cannot change your account and it cannot download.'
        ),
        h('div', connect)
      )
    );
  }

  // Pressed before the instance has a Google client. Says what is missing and
  // sends them to the one page that can fix it, rather than explaining OAuth on
  // a card they were not asking to read.
  function explainSetup() {
    modal({
      title: 'This instance needs a Google client first',
      body: [
        h(
          'p.muted',
          'Google only lets an application read your playlists with credentials issued to that application, and a shipped one would not stay secret. So this instance needs its own, created once.'
        ),
        h(
          'p.muted',
          'Settings has the steps, the exact redirect address to paste into the Google console, and the two boxes for the values it gives you back.'
        ),
        notice(
          'Everything else on this page works without it. A public playlist link needs no account at all.',
          '',
          'info'
        ),
      ],
      footer: [
        h(
          'a.btn.btn-primary',
          {
            href: '#/settings',
            onclick: () => document.querySelector('.modal-backdrop')?.remove(),
          },
          'Open Settings'
        ),
      ],
    });
  }

  function connectedCard(state) {
    const playlistSlot = h('div');
    let playlists = state.playlists || [];

    const renderPlaylists = () =>
      mount(
        playlistSlot,
        playlists.length === 0
          ? h('p.muted', 'No playlists read yet. Press Refresh to read them from your account.')
          : h(
              'div.card.card-inset',
              h(
                'div.list',
                playlists.map((playlist) => {
                  const tick = h('input', {
                    type: 'checkbox',
                    checked: playlist.selected,
                    onchange: () => {
                      playlist.selected = tick.checked;
                      saveSelection();
                    },
                  });
                  return h(
                    'div.list-row',
                    h('label.checkbox', { style: { margin: 0 } }, tick),
                    artwork(playlist.thumbnailUrl, { size: 40 }),
                    h(
                      'div.list-main',
                      h('div.list-title', playlist.title),
                      h(
                        'div.list-sub',
                        [
                          playlist.itemCount != null
                            ? `${formatNumber(playlist.itemCount)} item${playlist.itemCount === 1 ? '' : 's'}`
                            : null,
                          playlist.lastSyncedAt
                            ? `synced ${formatRelative(playlist.lastSyncedAt)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      )
                    )
                  );
                })
              )
            )
      );

    let saveTimer = null;
    const saveSelection = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const chosen = playlists.filter((p) => p.selected).map((p) => p.youtubeId);
          ({ playlists } = await api.youtubeSelection(chosen));
        } catch (err) {
          toast(err.message, 'error');
        }
      }, 500);
    };

    const refresh = h(
      'button.btn.btn-sm',
      {
        type: 'button',
        onclick: async () => {
          refresh.disabled = true;
          try {
            ({ playlists } = await api.youtubeRefreshPlaylists());
            renderPlaylists();
            toast(`Found ${formatNumber(playlists.length)} playlists.`, 'ok');
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            refresh.disabled = false;
          }
        },
      },
      'Refresh list'
    );

    const syncNow = h(
      'button.btn.btn-sm.btn-primary',
      {
        type: 'button',
        onclick: async () => {
          syncNow.disabled = true;
          try {
            await api.youtubeSyncNow();
            toast('Syncing followed playlists. Progress is on the Import page.', 'ok');
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            syncNow.disabled = false;
          }
        },
      },
      'Sync now'
    );

    const disconnect = h(
      'button.btn.btn-sm.btn-danger',
      {
        type: 'button',
        onclick: async () => {
          if (!window.confirm('Disconnect this YouTube account? Songs already imported stay.')) {
            return;
          }
          try {
            await api.youtubeDisconnect();
            toast('YouTube account disconnected.', 'ok');
            await loadAccount();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      'Disconnect'
    );

    renderPlaylists();

    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Your YouTube account'),
        h('div.spacer'),
        badge(state.account?.channelTitle || 'Connected', 'ok')
      ),
      h(
        'div.card-body',
        state.account?.lastError ? notice(state.account.lastError, 'warn', 'warn') : null,
        h(
          'p.muted',
          state.account?.lastSyncedAt
            ? `Last synced ${formatRelative(state.account.lastSyncedAt)}. Ticked playlists are re-checked when you open this page.`
            : 'Tick the playlists to follow. They are re-checked whenever you open this page.'
        ),
        playlistSlot,
        h(
          'p.small.subtle',
          { style: { marginTop: '12px' } },
          'Albums saved to a YouTube Music library are not listed: Google does not expose them to applications. Follow one with its playlist link above instead - YouTube Music offers that from the album’s share menu.'
        ),
        h('div.row', { style: { marginTop: '12px' } }, syncNow, refresh, h('div.spacer'), disconnect)
      )
    );
  }

  async function startConnect(button) {
    button.disabled = true;
    try {
      const { url } = await api.youtubeConnect();
      // A popup rather than a redirect, so anything half-typed on this page is
      // not thrown away by leaving it.
      const popup = window.open(url, 'syncmypod-youtube', 'width=520,height=680');
      if (!popup) {
        toast('Allow popups for this site, then press Connect again.', 'error');
        return;
      }
      const done = async (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source !== 'syncmypod-youtube') return;
        window.removeEventListener('message', done);
        await loadAccount();
        if (event.data.ok) toast('YouTube account connected.', 'ok');
      };
      window.addEventListener('message', done);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

}
