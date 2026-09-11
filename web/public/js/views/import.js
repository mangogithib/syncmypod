import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  badge,
  debounce,
  formatNumber,
  formatRelative,
  modal,
  notice,
  spinner,
  toast,
} from '../lib/ui.js';

// Bulk import.
//
// Three sources, none of which needs an account or a key:
//
//   * A pasted list of tracks, one per line. The universal route - it works for
//     a library held anywhere, including a Spotify export, a spreadsheet, or
//     something typed out by hand.
//   * A public Deezer playlist, by URL.
//   * A public YouTube playlist, by URL.
//
// The Spotify integration that used to be here needed OAuth, and went when
// Spotify started refusing Web API access to apps whose owner is not a Premium
// subscriber.

export async function renderImport(view, context) {
  const jobsSlot = h('div');
  const accountSlot = h('div');

  mount(
    view,
    notice(
      h(
        'div',
        h('strong', 'Every imported track is re-resolved. '),
        h(
          'span',
          'Whatever you paste is treated as a hint, not as metadata. Each line is matched against a real catalogue, so a rough "Artist - Title" still lands with proper credits, artwork and a track number.'
        )
      ),
      '',
      'info'
    ),
    accountSlot,
    h('div.grid-2', trackListCard(), deezerCard(), youtubeCard()),
    jobsSlot
  );

  await loadAccount();
  await loadJobs();

  // --- a connected YouTube account -----------------------------------------
  //
  // The only part of this app that needs an account anywhere. Everything else
  // works from a link or a pasted list; following someone's own playlists needs
  // their permission, and permission needs a sign-in.

  async function loadAccount() {
    if (!context.isCurrent()) return;
    mount(accountSlot, spinner('Checking YouTube account...'));
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
      !state.configured
        ? setupNeededCard(state.redirectUri)
        : !state.connected
          ? connectCard()
          : connectedCard(state)
    );
  }

  // Shown when the instance has no Google client yet. The steps are here rather
  // than in a wiki because this is where somebody hits the wall, and because
  // the redirect URI has to be copied exactly - so it is on screen, not
  // described.
  function setupNeededCard(redirectUri) {
    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Connect a YouTube account'),
        h('div.spacer'),
        badge('Setup needed', 'warn')
      ),
      h(
        'div.card-body',
        h(
          'p.muted',
          'Following your own YouTube playlists means reading your account, and Google only lets an application do that with credentials registered to it. Everything else on this page works without any of this.'
        ),
        h(
          'ol.steps',
          h(
            'li',
            'Open the Google Cloud console, create a project, and enable the ',
            h('strong', 'YouTube Data API v3'),
            '.'
          ),
          h('li', 'Under Credentials, create an OAuth client ID of type Web application.'),
          h(
            'li',
            'Add this exact address as an authorised redirect URI:',
            h('code.copyable', { title: 'Click to copy', onclick: copySelf }, redirectUri)
          ),
          h(
            'li',
            'On the OAuth consent screen, add yourself under Test users. The app does not need to be published or reviewed for your own account.'
          ),
          h(
            'li',
            'Paste the client ID and secret into ',
            h('a', { href: '#/settings' }, 'Settings'),
            '.'
          )
        ),
        notice(
          'Read-only, and only YouTube. The permission asked for lets this list your playlists and what is in them. It cannot change anything in your account, and it cannot download - the local app does that with its own separate sign-in.',
          '',
          'info'
        )
      )
    );
  }

  function connectCard() {
    const connect = h(
      'button.btn.btn-primary',
      { type: 'button', onclick: () => startConnect(connect) },
      icon('link', 15),
      'Connect YouTube account'
    );

    return h(
      'div.card',
      h('div.card-head', h('h2', 'Connect a YouTube account'), h('div.spacer')),
      h(
        'div.card-body',
        h(
          'p.muted',
          'Pick the playlists worth following and they are re-checked whenever you open this page, so new songs arrive here without pasting anything.'
        ),
        notice(
          'This is separate from the sign-in in the local app. That one lives on your own machine and fetches the audio. This one only reads your playlist list, and cannot download anything.',
          '',
          'info'
        ),
        h('div', connect)
      )
    );
  }

  function connectedCard(state) {
    const listSlot = h('div');
    let playlists = state.playlists;

    const render = () =>
      mount(
        listSlot,
        playlists.length === 0
          ? h(
              'p.muted',
              'No playlists found yet. Press Refresh to read them from your account.'
            )
          : h(
              'div.card',
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
                    playlist.thumbnailUrl
                      ? h('img.thumb', { src: playlist.thumbnailUrl, alt: '', loading: 'lazy' })
                      : null,
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
                          .join(' \u00b7 ')
                      )
                    )
                  );
                })
              )
            )
      );

    const saveSelection = debounce(async () => {
      try {
        const selected = playlists.filter((p) => p.selected).map((p) => p.youtubeId);
        const response = await api.youtubeSelection(selected);
        playlists = response.playlists;
      } catch (err) {
        toast(err.message, 'error');
      }
    }, 500);

    const refresh = h(
      'button.btn',
      {
        type: 'button',
        onclick: async () => {
          refresh.disabled = true;
          try {
            const response = await api.youtubeRefreshPlaylists();
            playlists = response.playlists;
            render();
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
      'button.btn.btn-primary',
      {
        type: 'button',
        onclick: async () => {
          syncNow.disabled = true;
          try {
            const response = await api.youtubeSyncNow();
            watchJob(response.jobId, 'followed playlists');
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
      'button.btn.btn-danger',
      {
        type: 'button',
        onclick: async () => {
          if (!window.confirm('Disconnect this YouTube account? Tracks already imported stay.')) {
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

    render();

    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'YouTube account'),
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
        listSlot,
        notice(
          'Albums saved to a YouTube Music library are not listed here, because Google does not expose them to applications. Import one with its playlist link instead - YouTube Music gives you that from the album\u2019s share menu.',
          '',
          'info'
        ),
        h('div.row', syncNow, refresh, h('div.spacer'), disconnect)
      )
    );
  }

  async function startConnect(button) {
    button.disabled = true;
    try {
      const { url } = await api.youtubeConnect();
      // A popup rather than a redirect, so a half-typed import on this page is
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

  function copySelf(event) {
    const text = event.currentTarget.textContent;
    navigator.clipboard?.writeText(text).then(
      () => toast('Copied.', 'ok'),
      () => toast('Copy it by hand: ' + text, 'info')
    );
  }


  async function loadJobs() {
    if (!context.isCurrent()) return;
    try {
      const { jobs } = await api.importJobs();
      if (!context.isCurrent()) return;
      mount(jobsSlot, jobs.length > 0 ? jobHistory(jobs) : null);
    } catch {
      // History is informational; a failure here should not break the page.
    }
  }

  // --- pasted list ---------------------------------------------------------

  function trackListCard() {
    const textarea = h('textarea.textarea', {
      rows: 9,
      placeholder: 'Arijit Singh - Kesariya\nRadiohead - Karma Police\nSid Sriram - Uyire',
      style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' },
    });

    const orderSelect = h(
      'select.select',
      h('option', { value: 'artist-title' }, 'Artist - Title'),
      h('option', { value: 'title-artist' }, 'Title - Artist')
    );

    const playlistName = h('input.input', { type: 'text', placeholder: 'Optional' });
    const previewSlot = h('div');
    const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Import list');

    // Live preview of how the lines will be read.
    //
    // "Artist - Title" and "Title - Artist" are indistinguishable to a machine,
    // and getting it backwards across 300 lines is tedious to undo. Showing the
    // first few parsed rows makes the right choice obvious before committing.
    const preview = debounce(async () => {
      const text = textarea.value;
      if (!text.trim()) {
        mount(previewSlot);
        return;
      }
      try {
        const result = await api.previewTrackList(text, orderSelect.value);
        mount(
          previewSlot,
          h(
            'div',
            { style: { marginTop: '4px' } },
            h(
              'div.small.muted',
              { style: { marginBottom: '6px' } },
              `${formatNumber(result.total)} line${result.total === 1 ? '' : 's'} understood as:`
            ),
            h(
              'div.card',
              h(
                'div.list',
                result.sample.map((entry) =>
                  h(
                    'div.list-row',
                    { style: { padding: '6px 12px' } },
                    h(
                      'div.list-main',
                      h('div.small', { style: { fontWeight: 500 } }, entry.title || '(no title)'),
                      h('div.small.subtle', entry.artist || 'no artist - will search on title alone')
                    )
                  )
                )
              )
            ),
            result.total > result.sample.length
              ? h('div.small.subtle', { style: { marginTop: '6px' } },
                  `and ${formatNumber(result.total - result.sample.length)} more`)
              : null
          )
        );
      } catch (err) {
        mount(previewSlot, notice(err.message, 'danger', 'warn'));
      }
    }, 400);

    textarea.addEventListener('input', preview);
    orderSelect.addEventListener('change', preview);

    return h(
      'div.card',
      h('div.card-head', h('h2', 'Paste a list of tracks'), h('div.spacer'), badge('No account needed', 'ok')),
      h(
        'div.card-body',
        h(
          'form.stack',
          {
            onsubmit: async (event) => {
              event.preventDefault();
              if (!textarea.value.trim()) {
                toast('Paste some tracks first.', 'error');
                return;
              }
              submit.disabled = true;
              try {
                const name = playlistName.value.trim();
                const response = await api.importTrackList({
                  text: textarea.value,
                  order: orderSelect.value,
                  playlistName: name || undefined,
                  createPlaylist: Boolean(name),
                });
                watchJob(response.jobId, name || 'Pasted list');
                textarea.value = '';
                playlistName.value = '';
                mount(previewSlot);
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                submit.disabled = false;
              }
            },
          },
          h(
            'div.field',
            h('label', 'One track per line'),
            textarea,
            h(
              'span.hint',
              'Also accepts tab-separated columns and quoted CSV, so a spreadsheet or a Spotify export pasted straight in will work.'
            )
          ),
          h('div.field', h('label', 'Each line reads as'), orderSelect),
          previewSlot,
          h(
            'div.field',
            h('label', 'Also create a playlist called'),
            playlistName,
            h('span.hint', 'Leave blank to add to your library only. An existing playlist with the same name is added to rather than duplicated.')
          ),
          h('div', submit)
        )
      )
    );
  }

  // --- Deezer playlist -----------------------------------------------------

  function deezerCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'https://www.deezer.com/playlist/1234567890',
    });
    const createPlaylist = h('input', { type: 'checkbox', checked: true });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Import playlist');

    return h(
      'div.card',
      h('div.card-head', h('h2', 'Import a Deezer playlist'), h('div.spacer'), badge('No account needed', 'ok')),
      h(
        'div.card-body',
        h(
          'form.stack',
          {
            onsubmit: async (event) => {
              event.preventDefault();
              if (!input.value.trim()) {
                toast('Paste a Deezer playlist link.', 'error');
                return;
              }
              submit.disabled = true;
              try {
                const response = await api.importDeezerPlaylist({
                  playlist: input.value.trim(),
                  createPlaylist: createPlaylist.checked,
                });
                watchJob(response.jobId, 'Deezer playlist');
                input.value = '';
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                submit.disabled = false;
              }
            },
          },
          h(
            'div.field',
            h('label', 'Playlist link or id'),
            input,
            h('span.hint', 'The playlist must be public. A full URL or just the numeric id both work.')
          ),
          h(
            'label.checkbox',
            createPlaylist,
            h('span', 'Recreate it as a playlist here')
          ),
          notice(
            'Playlist entries already carry a Deezer track id, so these resolve by direct lookup rather than by search - a long playlist imports quickly and accurately.',
            '',
            'info'
          ),
          h('div', submit)
        )
      )
    );
  }

  // --- YouTube playlist ----------------------------------------------------

  function youtubeCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'https://www.youtube.com/playlist?list=PL...',
    });
    const createPlaylist = h('input', { type: 'checkbox', checked: true });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Import playlist');

    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Import a YouTube playlist'),
        h('div.spacer'),
        badge('No account needed', 'ok')
      ),
      h(
        'div.card-body',
        h(
          'form.stack',
          {
            onsubmit: async (event) => {
              event.preventDefault();
              if (!input.value.trim()) {
                toast('Paste a YouTube playlist link.', 'error');
                return;
              }
              submit.disabled = true;
              try {
                const response = await api.importYouTubePlaylist({
                  playlist: input.value.trim(),
                  createPlaylist: createPlaylist.checked,
                });
                watchJob(response.jobId, 'YouTube playlist');
                input.value = '';
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                submit.disabled = false;
              }
            },
          },
          h(
            'div.field',
            h('label', 'Playlist link'),
            input,
            h(
              'span.hint',
              'The playlist must be public or unlisted. Copying the address straight out of the browser works, even if it is a link to one video inside the playlist.'
            )
          ),
          h('label.checkbox', createPlaylist, h('span', 'Recreate it as a playlist here')),
          notice(
            h(
              'div',
              h('strong', 'Every track is checked against a real catalogue first. '),
              h(
                'span',
                'A video title is not metadata, so it is only ever used as a search. Tracks the catalogues recognise arrive with proper artist, album and artwork. Tracks that only exist on YouTube arrive with their title and nothing else, and wait in your library until you fill in the artist - so nothing wrong is ever written to your iPod.'
              )
            ),
            '',
            'info'
          ),
          h('div', submit)
        )
      )
    );
  }

  // --- job progress --------------------------------------------------------

  // Shows live progress for a running import.
  //
  // The server runs the job in the background and returns an id immediately, so
  // this polls. Closing the dialog does not cancel anything - the import keeps
  // going server-side, which is what makes a 300-track import survive a closed
  // laptop.
  function watchJob(jobId, label) {
    const progressBar = h('div.progress-bar', { style: { width: '0%' } });
    const statusLine = h('p.muted', 'Starting...');
    const detail = h('div');

    const control = modal({
      title: `Importing ${label}`,
      body: [
        statusLine,
        h('div.progress', progressBar),
        detail,
        notice('This runs on the server. You can close this and it will carry on.', '', 'info'),
      ],
    });

    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const job = await api.importJob(jobId);

        const percent = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
        progressBar.style.width = `${percent}%`;
        statusLine.textContent =
          job.status === 'done'
            ? `Finished: ${formatNumber(job.added)} added, ${formatNumber(job.skipped)} already present${
                job.failed > 0 ? `, ${formatNumber(job.failed)} failed` : ''
              }.`
            : job.status === 'error'
              ? 'The import stopped with an error.'
              : `${formatNumber(job.processed)} of ${formatNumber(job.total)} processed...`;

        if (job.status === 'error' && job.error) {
          mount(detail, notice(job.error, 'danger', 'warn'));
        }

        // Per-item problems, once there is a final answer to report.
        if (job.status === 'done' && Array.isArray(job.report) && job.report.length > 0) {
          mount(
            detail,
            h(
              'div',
              h('p.small', { style: { fontWeight: 600, margin: '8px 0' } },
                `${job.report.length} track${job.report.length === 1 ? '' : 's'} need attention:`),
              h(
                'div.card',
                h(
                  'div.list',
                  job.report.slice(0, 20).map((entry) =>
                    h(
                      'div.list-row',
                      h(
                        'div.list-main',
                        h('div.list-title', entry.title || 'Unknown'),
                        h('div.list-sub', entry.reason)
                      ),
                      badge(entry.state, entry.state === 'error' ? 'danger' : 'warn')
                    )
                  )
                )
              ),
              h('p.small.subtle', { style: { marginTop: '8px' } },
                h('span', 'Fix them in '),
                h('a', { href: '#/library?state=unresolved' }, 'the library'),
                h('span', '.'))
            )
          );
        }

        if (job.status === 'done' || job.status === 'error') {
          stopped = true;
          context.refreshStats();
          if (job.status === 'done') {
            toast(`Imported ${label}: ${job.added} added.`, 'ok');
          }
          loadJobs();
          return;
        }

        setTimeout(poll, 1200);
      } catch (err) {
        stopped = true;
        mount(detail, notice(`Lost track of the import: ${err.message}`, 'danger', 'warn'));
      }
    };

    // Stop polling once the dialog is gone, so a closed dialog does not keep
    // requesting forever.
    const originalClose = control.close;
    control.close = () => {
      stopped = true;
      originalClose();
    };

    poll();
  }

  function jobHistory(jobs) {
    const sourceLabel = {
      'track-list': 'Pasted list',
      'deezer-playlist': 'Deezer playlist',
    };

    return h(
      'div.card',
      { style: { marginTop: '24px' } },
      h('div.card-head', h('h2', 'Recent imports')),
      h(
        'div.list',
        jobs.map((job) =>
          h(
            'div.list-row',
            h(
              'div.list-main',
              h('div.list-title', job.sourceName || sourceLabel[job.source] || job.source),
              h(
                'div.list-sub',
                `${formatNumber(job.added)} added, ${formatNumber(job.skipped)} skipped${
                  job.failed > 0 ? `, ${formatNumber(job.failed)} failed` : ''
                }`
              ),
              job.error ? h('div.small', { style: { color: 'var(--danger)' } }, job.error) : null
            ),
            badge(
              job.status,
              job.status === 'done' ? 'ok' : job.status === 'error' ? 'danger' : 'warn'
            ),
            h('span.small.subtle.nowrap', formatRelative(job.createdAt))
          )
        )
      )
    );
  }

}
