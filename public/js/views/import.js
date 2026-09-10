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

// Importing from Spotify: link the account, pick playlists, watch the job run.

export async function renderImport(view, context) {
  const body = h('div');
  mount(view, body);
  await load();

  async function load() {
    if (!context.isCurrent()) return;
    mount(body, spinner('Checking Spotify...'));

    try {
      const [status, { jobs }] = await Promise.all([
        api.spotifyStatus(),
        api.importJobs().catch(() => ({ jobs: [] })),
      ]);
      if (!context.isCurrent()) return;

      const blocks = [];

      // Three distinct states, each with a different fix: no credentials on the
      // server, credentials but no linked account, or ready.
      if (!status.configured) {
        blocks.push(notConfigured());
      } else if (!status.linked) {
        blocks.push(notLinked(status));
      } else {
        blocks.push(linked(status));
        blocks.push(h('div', { id: 'playlist-slot' }, spinner('Loading your Spotify playlists...')));
      }

      if (jobs.length > 0) blocks.push(jobHistory(jobs));

      mount(body, blocks);

      if (status.configured && status.linked) loadPlaylists();
    } catch (err) {
      if (err.status === 401) return;
      mount(body, notice(err.message, 'danger', 'warn'));
    }
  }

  function notConfigured() {
    return h(
      'div.card.card-pad',
      h('h2', { style: { fontSize: '15px', marginBottom: '8px' } }, 'Spotify is not configured'),
      h(
        'p.muted',
        { style: { marginBottom: '16px' } },
        'Importing playlists needs a Spotify app of your own. It takes a couple of minutes and is free.'
      ),
      h(
        'ol.muted',
        { style: { paddingLeft: '20px', display: 'grid', gap: '6px' } },
        h('li', h('span', 'Open '), h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener noreferrer' }, 'developer.spotify.com/dashboard'), h('span', ' and create an app.')),
        h('li', 'Copy its Client ID and Client Secret.'),
        h('li', h('span', 'Add them to this instance as '), h('code', 'SPOTIFY_CLIENT_ID'), h('span', ' and '), h('code', 'SPOTIFY_CLIENT_SECRET'), h('span', ', then restart it.')),
        h('li', h('span', 'Register the redirect URI shown in '), h('a', { href: '#/settings' }, 'Settings'), h('span', ' on the Spotify app.'))
      ),
      h(
        'p.small.subtle',
        { style: { marginTop: '16px' } },
        'Search and metadata resolution work with just the id and secret. The redirect URI is only needed to read your own playlists.'
      )
    );
  }

  function notLinked(status) {
    return h(
      'div.card.card-pad',
      h('h2', { style: { fontSize: '15px', marginBottom: '8px' } }, 'Link your Spotify account'),
      h(
        'p.muted',
        { style: { marginBottom: '16px' } },
        'Your own playlists and saved songs are private, so importing them needs your permission. SyncMyPod asks for read-only access.'
      ),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: async () => {
            try {
              const { url } = await api.spotifyAuthorize();
              window.location.href = url;
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        icon('link', 15),
        'Connect Spotify'
      ),
      status.redirectUri
        ? h(
            'p.small.subtle',
            { style: { marginTop: '16px' } },
            h('span', 'This must be registered as a Redirect URI on your Spotify app: '),
            h('code', status.redirectUri)
          )
        : null
    );
  }

  function linked(status) {
    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Spotify'),
        badge('Connected', 'ok'),
        h('div.spacer'),
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: async () => {
              try {
                await api.spotifyUnlink();
                toast('Spotify disconnected.', 'ok');
                load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Disconnect'
        )
      ),
      h(
        'div.card-body',
        h(
          'div.row-between',
          h(
            'div',
            h('div', `Connected as ${status.account?.displayName || 'unknown'}`),
            h('div.small.subtle', `Linked ${formatRelative(status.account?.linkedAt)}`)
          ),
          h(
            'button.btn',
            {
              type: 'button',
              onclick: () => startImport(() => api.importSpotifySaved({ createPlaylist: false }), 'Liked Songs'),
            },
            icon('download', 15),
            'Import Liked Songs'
          )
        )
      )
    );
  }

  async function loadPlaylists() {
    const slot = document.getElementById('playlist-slot');
    if (!slot) return;

    try {
      const { playlists } = await api.spotifyPlaylists();
      if (!context.isCurrent()) return;

      if (playlists.length === 0) {
        mount(
          slot,
          emptyState({
            iconName: 'list',
            title: 'No playlists found',
            body: 'This Spotify account has no playlists to import.',
          })
        );
        return;
      }

      mount(
        slot,
        h(
          'div.card',
          h('div.card-head', h('h2', 'Your Spotify playlists'), h('div.spacer'),
            h('span.small.subtle', `${playlists.length} found`)),
          h(
            'div.list',
            playlists.map((playlist) =>
              h(
                'div.list-row',
                artwork(playlist.imageUrl, { size: 42 }),
                h(
                  'div.list-main',
                  h('div.list-title', playlist.name),
                  h(
                    'div.list-sub',
                    [
                      `${playlist.trackCount ?? '?'} songs`,
                      playlist.owner ? `by ${playlist.owner}` : null,
                    ]
                      .filter(Boolean)
                      .join(' - ')
                  )
                ),
                h(
                  'div.list-actions',
                  // Already-imported playlists get the softer label: re-running
                  // is legitimate (to pick up new additions) but it should be
                  // clear it is not the first time.
                  playlist.importedAs
                    ? h(
                        'a.badge.badge-accent',
                        { href: `#/playlists/${playlist.importedAs.id}` },
                        'Imported'
                      )
                    : null,
                  h(
                    'button.btn.btn-sm',
                    {
                      type: 'button',
                      onclick: () =>
                        startImport(
                          () =>
                            api.importSpotifyPlaylist(playlist.spotifyId, {
                              createPlaylist: true,
                            }),
                          playlist.name
                        ),
                    },
                    playlist.importedAs ? 'Re-import' : 'Import'
                  )
                )
              )
            )
          )
        )
      );
    } catch (err) {
      if (err.status === 401) return;
      mount(slot, notice(err.message, 'danger', 'warn'));
    }
  }

  // Kicks off an import and shows live progress.
  //
  // The server runs the job in the background and returns an id immediately, so
  // this polls. Closing the dialog does not cancel anything - the import keeps
  // going server-side, which is the behaviour that makes a 300-track import
  // survive a closed laptop.
  async function startImport(starter, label) {
    const progressBar = h('div.progress-bar', { style: { width: '0%' } });
    const statusLine = h('p.muted', 'Starting...');
    const detail = h('div');

    const control = modal({
      title: `Importing ${label}`,
      body: [
        statusLine,
        h('div.progress', progressBar),
        detail,
        notice(
          'This runs on the server. You can close this and it will carry on.',
          '',
          'info'
        ),
      ],
    });

    let jobId;
    try {
      const response = await starter();
      jobId = response.jobId;
    } catch (err) {
      mount(detail, notice(err.message, 'danger', 'warn'));
      statusLine.textContent = 'Could not start the import.';
      return;
    }

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
            load();
          }
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
              h('div.list-title', job.sourceName || job.source),
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
