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
    h('div.grid-2', trackListCard(), deezerCard(), youtubeCard()),
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
