import { api } from '../lib/api.js';
import { h, mount } from '../lib/dom.js';
import {
  badge,
  debounce,
  formatNumber,
  formatRelative,
  modal,
  notice,
  toast,
} from '../lib/ui.js';

// Bulk import.
//
// Two boxes, neither needing an account or a key:
//
//   * A playlist link from any service. Which one it is comes from the address;
//     the reader for each lives in providers/playlists.js.
//   * A pasted list of tracks, one per line. The universal route - it works for
//     a library held anywhere, including an export, a spreadsheet, or something
//     typed out by hand.
//
// The Spotify integration that used to be here needed OAuth, and went when
// Spotify started refusing Web API access to apps whose owner is not a Premium
// subscriber.

export async function renderImport(view, context) {
  const jobsSlot = h('div');

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
    h('div.grid-2', playlistCard(), trackListCard()),
    h(
      'p.small.subtle',
      { style: { marginTop: '4px' } },
      'These import once, as the playlist is now. To keep up with a playlist that is still being added to, follow it under ',
      h('a', { href: '#/sources' }, 'Sources'),
      ' instead.'
    ),
    jobsSlot
  );

  await loadJobs();

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

  // --- any playlist link ---------------------------------------------------

  // One box for every service.
  //
  // There used to be a card each for Deezer and YouTube, which asked the user to
  // classify their own link before pasting it. The address already says which
  // service it is, so the box reads it and gets on with it. Adding a platform
  // is a reader in providers/playlists.js and a line in this hint.
  function playlistCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'Paste a playlist link from any service',
    });
    const createPlaylist = h('input', { type: 'checkbox', checked: true });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Import playlist');
    const platformSlot = h('div.small.subtle', { style: { marginTop: '6px' } });

    // Filled from the server rather than hardcoded here, so this list cannot
    // drift from what the readers actually support.
    api
      .importPlatforms()
      .then(({ platforms }) => {
        mount(
          platformSlot,
          h('span', 'Works with '),
          h('strong', platforms.map((p) => p.label).join(', ')),
          h('span', '.')
        );
      })
      .catch(() => {});

    return h(
      'div.card',
      h(
        'div.card-head',
        h('h2', 'Import a playlist'),
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
                toast('Paste a playlist link first.', 'error');
                return;
              }
              submit.disabled = true;
              submit.textContent = 'Reading...';
              try {
                const response = await api.importPlaylist({
                  url: input.value.trim(),
                  createPlaylist: createPlaylist.checked,
                });
                watchJob(response.jobId, `${response.platform} playlist`);
                input.value = '';
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                submit.disabled = false;
                submit.textContent = 'Import playlist';
              }
            },
          },
          h(
            'div.field',
            h('label', 'Playlist link'),
            input,
            h(
              'span.hint',
              'The playlist must be public or unlisted. Copying the address straight out of the browser or an app\u2019s share menu works, even if it points at one song inside the playlist.'
            ),
            platformSlot
          ),
          h('label.checkbox', createPlaylist, h('span', 'Recreate it as a playlist here')),
          notice(
            h(
              'div',
              h('strong', 'Every track is checked against a real catalogue first. '),
              h(
                'span',
                'Credits from a music service - Spotify, Apple Music, Deezer - are records, so they survive even when a track cannot be matched. A YouTube playlist is a list of videos, so its titles are only ever used as a search: those tracks arrive with a title alone until you fill the artist in.'
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
