import { api } from '../lib/api.js';
import { h, mount } from '../lib/dom.js';
import { badge, formatNumber, formatRelative, modal, notice, toast } from '../lib/ui.js';

// Bulk import: a playlist link from any service, read once.
//
// Which service it is comes from the address, so there is one box rather than
// one per platform; the reader for each lives in providers/playlists.js.
//
// **The pasted track list is gone from this page.** It was a second box doing
// the same job by a worse route - type "Artist - Title" on three hundred lines
// and pick which side is which - and it made a page with one job look like a
// page with two. The endpoint behind it is untouched, so nothing that used it
// is broken; it simply is not the thing to offer somebody who has a playlist
// link in their clipboard.
//
// An import happens once, as the playlist is that afternoon. Sources is the
// page for a playlist that keeps changing.

export async function renderImport(view, context) {
  const jobsSlot = h('div');

  mount(view, playlistCard(), jobsSlot);

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

  function playlistCard() {
    const input = h('input.input', {
      type: 'text',
      placeholder: 'Paste a playlist link',
      'aria-label': 'Playlist link',
    });
    const createPlaylist = h('input', { type: 'checkbox', checked: true });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Import');
    const platformSlot = h('div.small.subtle', { style: { marginTop: '6px' } });

    // Filled from the server rather than hardcoded here, so this list cannot
    // drift from what the readers actually support.
    api
      .importPlatforms()
      .then(({ platforms }) => {
        mount(platformSlot, h('span', platforms.map((p) => p.label).join(', ')));
      })
      .catch(() => {});

    return h(
      'div.card',
      h('div.card-head', h('h2', 'Import a playlist'), h('div.spacer'), badge('No account needed', 'ok')),
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
                submit.textContent = 'Import';
              }
            },
          },
          h('div.field', input, platformSlot),
          h('label.checkbox', createPlaylist, h('span', 'Recreate it as a playlist here')),
          h('div', submit),
          h(
            'p.small.subtle',
            'This imports once. To keep up with a playlist that is still changing, follow it under ',
            h('a', { href: '#/sources' }, 'Sources'),
            '.'
          )
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
        h('p.small.subtle', 'This runs on the server. You can close this and it will carry on.'),
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
        //
        // No "fix them in the library" line any more: songs that arrive with a
        // title and nothing else are looked up again on their own a moment
        // later, so most of this list resolves itself. See services/rematch.js.
        if (job.status === 'done' && Array.isArray(job.report) && job.report.length > 0) {
          mount(
            detail,
            h(
              'div',
              h(
                'p.small',
                { style: { fontWeight: 600, margin: '8px 0' } },
                `${job.report.length} track${job.report.length === 1 ? '' : 's'} could not be matched yet:`
              ),
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
              )
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

  // The last 25, which is what the server returns. Older ones are of no use:
  // an import is a thing that happened, and the report that mattered was shown
  // while it was running.
  function jobHistory(jobs) {
    const sourceLabel = {
      'track-list': 'Pasted list',
      'deezer-playlist': 'Deezer playlist',
      rematch: 'Looked up missing artists',
    };

    return h(
      'div.card',
      { style: { marginTop: '24px' } },
      h('div.card-head', h('h2', 'Recent imports')),
      h(
        'div.list',
        jobs.slice(0, 25).map((job) =>
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
