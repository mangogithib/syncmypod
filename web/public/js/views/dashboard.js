import { api } from '../lib/api.js';
import { h, icon } from '../lib/dom.js';
import {
  artwork,
  formatNumber,
  formatRelative,
  formatTotalDuration,
  metadataBadge,
  notice,
  renderAsync,
} from '../lib/ui.js';

// The overview page. Answers, in order: how big is the library, is anything
// wrong with it, and is it reaching an iPod.

export async function renderDashboard(view, context) {
  await renderAsync(
    view,
    async () => {
      // Fired together, and individually tolerant: a dashboard should still
      // render if one panel's data is unavailable.
      const [stats, recent, devices, playlists] = await Promise.all([
        api.stats(),
        api.tracks({ limit: 8, sort: 'added' }),
        api.devices().catch(() => ({ devices: [] })),
        api.playlists().catch(() => ({ playlists: [] })),
      ]);
      return { stats, recent, devices, playlists };
    },
    ({ stats, recent, devices, playlists }) => {
      const blocks = [];

      // Songs with no artist. They still sync, with the field blank, so this is
      // a "worth fixing" rather than a blocker.
      //
      // **The link has to point at the same set this number counts.** It went
      // to `state=unresolved`, which is the resolver's state machine, while the
      // count is "has no artist and has not been accepted" - two different
      // sets. A song corrected by hand is `manual` and can still have no
      // artist, so it was counted here and missing from the list this link
      // opened. Clearing everything the list showed left the warning up, with
      // nothing on the page to explain why, and no way to make it go away.
      if (stats.needsAttention > 0) {
        blocks.push(
          h(
            'div.notice.notice-warn',
            icon('warn', 16),
            h(
              'div',
              h(
                'strong',
                `${formatNumber(stats.needsAttention)} song${stats.needsAttention === 1 ? '' : 's'} with no artist. `
              ),
              h('a', { href: '#/library?state=flagged' }, 'Review')
            )
          )
        );
      }

      // Tracks the local app could not fetch. Distinct from the row above:
      // those are in the library and sync with blank fields, these never
      // reached the iPod at all, and the fix is a source URL rather than an
      // artist name.
      if (stats.syncFailed > 0) {
        blocks.push(
          h(
            'div.notice.notice-danger',
            icon('warn', 16),
            h(
              'div',
              h(
                'strong',
                `${formatNumber(stats.syncFailed)} song${stats.syncFailed === 1 ? '' : 's'} did not reach the iPod. `
              ),
              h('a', { href: '#/library?state=sync-failed' }, 'See which')
            )
          )
        );
      }

      if (devices.devices.length === 0) {
        blocks.push(
          notice(
            h(
              'div',
              h('strong', 'No computer is paired yet. '),
              h('a', { href: '#/devices' }, 'Pair one')
            ),
            'accent',
            'info'
          )
        );
      }

      blocks.push(
        h(
          'div.stat-grid',
          stat('Songs', formatNumber(stats.trackCount), formatTotalDuration(stats.totalDurationMs)),
          stat('Albums', formatNumber(stats.albumCount)),
          stat('Artists', formatNumber(stats.artistCount), `${formatNumber(stats.followedCount)} followed`),
          stat('Playlists', formatNumber(stats.playlistCount)),
          stats.needsAttention > 0
            ? stat('No artist', formatNumber(stats.needsAttention), null, true)
            : stat('Ready to sync', formatNumber(stats.trackCount - stats.needsAttention))
        )
      );

      blocks.push(
        h(
          'div.grid-2',
          recentlyAdded(recent),
          h('div.stack', devicePanel(devices.devices), playlistPanel(playlists.playlists))
        )
      );

      return blocks;
    }
  );

  if (!context.isCurrent()) return;
}

function stat(label, value, meta, attention = false) {
  return h(
    `div.stat${attention ? '.attention' : ''}`,
    h('div.stat-label', label),
    h('div.stat-value', value),
    meta ? h('div.stat-meta', meta) : null
  );
}

function recentlyAdded({ tracks }) {
  return h(
    'div.card',
    h('div.card-head', h('h2', 'Recently added'), h('div.spacer'),
      h('a.small', { href: '#/library' }, 'All songs')),
    tracks.length === 0
      ? h('div.card-body', h('p.muted.small', 'Nothing yet.'))
      : h(
          'div.list',
          tracks.map((track) =>
            h(
              'div.list-row',
              artwork(track.artworkUrl, { size: 36 }),
              h(
                'div.list-main',
                h('div.list-title', track.title),
                h('div.list-sub', track.artistCredit || 'Unknown artist')
              ),
              h('div.list-actions',
                track.metadataState !== 'resolved' ? metadataBadge(track.metadataState) : null,
                h('span.small.subtle.nowrap', formatRelative(track.addedAt)))
            )
          )
        )
  );
}

function devicePanel(devices) {
  return h(
    'div.card',
    h('div.card-head', h('h2', 'Paired computers'), h('div.spacer'),
      h('a.small', { href: '#/devices' }, 'Manage')),
    devices.length === 0
      ? h('div.card-body', h('p.muted.small', 'None paired.'))
      : h(
          'div.list',
          devices.map((device) =>
            h(
              'div.list-row',
              h('span.subtle', icon('device', 18)),
              h(
                'div.list-main',
                h('div.list-title', device.name),
                h(
                  'div.list-sub',
                  device.ipodModel
                    ? `${device.ipodModel} - ${device.syncedTracks} synced`
                    : 'No iPod seen yet'
                )
              ),
              h('span.small.subtle.nowrap', formatRelative(device.lastSeenAt))
            )
          )
        )
  );
}

function playlistPanel(playlists) {
  const syncing = playlists.filter((playlist) => playlist.syncToIpod);
  return h(
    'div.card',
    h('div.card-head', h('h2', 'Playlists'), h('div.spacer'),
      h('a.small', { href: '#/playlists' }, 'Manage')),
    playlists.length === 0
      ? h('div.card-body', h('p.muted.small', 'No playlists yet.'))
      : h(
          'div.list',
          playlists.slice(0, 6).map((playlist) =>
            h(
              'a.list-row',
              { href: `#/playlists/${playlist.id}`, style: { color: 'inherit', textDecoration: 'none' } },
              artwork(playlist.artworkUrl, { size: 36 }),
              h(
                'div.list-main',
                h('div.list-title', playlist.name),
                h('div.list-sub', `${playlist.trackCount} songs`)
              ),
              // Only worth flagging the exception: most playlists sync.
              !playlist.syncToIpod ? h('span.badge', 'Not syncing') : null
            )
          ),
          playlists.length > 6
            ? h('div.list-row', h('span.small.subtle', `and ${playlists.length - 6} more`))
            : null,
          h(
            'div.list-row',
            h('span.small.subtle', `${syncing.length} of ${playlists.length} syncing`)
          )
        )
  );
}
