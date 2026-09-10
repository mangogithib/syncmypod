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

      // Unresolved tracks are the one thing on this page that needs acting on:
      // they are in the library but excluded from every sync, so silence about
      // them would be misleading.
      if (stats.needsAttention > 0) {
        blocks.push(
          h(
            'div.notice.notice-warn',
            icon('warn', 16),
            h(
              'div',
              h('strong', `${formatNumber(stats.needsAttention)} track${stats.needsAttention === 1 ? '' : 's'} without confirmed metadata. `),
              h('span', 'These are skipped when syncing. '),
              h('a', { href: '#/library?state=unresolved' }, 'Review them')
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
              h('span', 'The local app is what downloads audio and writes to the iPod. '),
              h('a', { href: '#/devices' }, 'Pair a computer')
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
            ? stat('Needs attention', formatNumber(stats.needsAttention), 'Not syncable', true)
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
      ? h('div.card-body', h('p.muted.small',
          'Nothing yet. Use Add music to search for songs, or Import to pull in a Spotify playlist.'))
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
            h('span.small.subtle', `${syncing.length} of ${playlists.length} set to sync to the iPod`)
          )
        )
  );
}
