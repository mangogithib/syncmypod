import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import {
  badge,
  confirmDialog,
  emptyState,
  formatBytes,
  formatNumber,
  formatRelative,
  modal,
  notice,
  renderAsync,
  toast,
} from '../lib/ui.js';

// Paired computers.
//
// A "device" is an installation of the local sync app, not the iPod itself: the
// local app is what has a token, and the iPod is what it reports seeing. One
// computer can have different iPods plugged in over time.

export async function renderDevices(view, context) {
  context.setActions(
    h(
      'button.btn.btn-primary.btn-sm',
      { type: 'button', onclick: () => pairDialog(() => renderDevices(view, context)) },
      icon('plus', 15),
      'Pair a computer'
    )
  );

  await renderAsync(
    view,
    () => api.devices(),
    ({ devices, serverUrl }) => {
      const blocks = [];

      blocks.push(
        notice(
          h(
            'div',
            h('strong', 'This server never touches audio. '),
            h(
              'span',
              'It holds your library and playlists only. The local app on a paired computer is what downloads tracks, writes them to the iPod, and deletes the downloads afterwards.'
            )
          ),
          '',
          'info'
        )
      );

      if (devices.length === 0) {
        blocks.push(
          emptyState({
            iconName: 'device',
            title: 'No computers paired',
            body:
              'Pair the computer your iPod plugs into. It gets its own token, so your password is never stored on it.',
            action: h(
              'button.btn.btn-primary',
              { type: 'button', onclick: () => pairDialog(() => renderDevices(view, context)) },
              'Pair a computer'
            ),
          })
        );
        blocks.push(serverDetails(serverUrl));
        return blocks;
      }

      blocks.push(
        h(
          'div.stack',
          devices.map((device) => deviceCard(device, () => renderDevices(view, context)))
        )
      );
      blocks.push(serverDetails(serverUrl));
      return blocks;
    }
  );
}

function deviceCard(device, onChanged) {
  // A 6th/7th gen Classic needs the iTunesDB signature that older models do
  // not. Surfacing it here means the model-specific behaviour is visible rather
  // than being a silent branch inside the local app.
  const generationNote =
    device.ipodGeneration && /6|7|classic/i.test(device.ipodGeneration)
      ? 'Classic 6th/7th gen - database signature required'
      : device.ipodGeneration
        ? `${device.ipodGeneration} - no database signature needed`
        : null;

  const usedBytes =
    device.ipodCapacityBytes && device.ipodFreeBytes
      ? device.ipodCapacityBytes - device.ipodFreeBytes
      : null;

  return h(
    'div.card',
    h(
      'div.card-head',
      h('span.subtle', icon('device', 20)),
      h('h2', device.name),
      device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 300_000
        ? badge('Active', 'ok')
        : null,
      h('div.spacer'),
      h(
        'button.btn.btn-sm',
        {
          type: 'button',
          onclick: () => historyDialog(device),
        },
        'Sync history'
      ),
      h(
        'button.btn.btn-sm.btn-danger',
        {
          type: 'button',
          onclick: async () => {
            const confirmed = await confirmDialog({
              title: 'Revoke this computer?',
              message: `"${device.name}" will stop being able to sync. Its token becomes invalid immediately, and it would have to be paired again. Nothing already on the iPod is affected.`,
              confirmLabel: 'Revoke',
              danger: true,
            });
            if (!confirmed) return;
            try {
              await api.revokeDevice(device.id);
              toast('Device revoked.', 'ok');
              onChanged();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Revoke'
      )
    ),
    h(
      'div.card-body',
      h(
        'dl.kv',
        h('dt', 'Last seen'),
        h('dd', formatRelative(device.lastSeenAt)),
        h('dt', 'Paired'),
        h('dd', formatRelative(device.createdAt)),
        h('dt', 'Token'),
        h('dd', h('span.mono', `${device.tokenPrefix}...`)),
        device.platform ? h('dt', 'Platform') : null,
        device.platform ? h('dd', `${device.platform}${device.appVersion ? ` - app ${device.appVersion}` : ''}`) : null,
        h('dt', 'iPod'),
        h(
          'dd',
          device.ipodName || device.ipodModel
            ? h(
                'div',
                h('div', [device.ipodName, device.ipodModel].filter(Boolean).join(' - ')),
                generationNote ? h('div.small.subtle', generationNote) : null
              )
            : h('span.subtle', 'Not seen yet')
        ),
        device.ipodCapacityBytes ? h('dt', 'Storage') : null,
        device.ipodCapacityBytes
          ? h(
              'dd',
              `${formatBytes(usedBytes)} used of ${formatBytes(device.ipodCapacityBytes)} - ${formatBytes(device.ipodFreeBytes)} free`
            )
          : null,
        h('dt', 'Tracks synced'),
        h('dd', formatNumber(device.syncedTracks)),
        h('dt', 'Last sync'),
        h('dd', formatRelative(device.lastSyncAt))
      )
    )
  );
}

async function historyDialog(device) {
  const body = h('div', h('p.muted', 'Loading...'));
  modal({ title: `${device.name} - sync history`, wide: true, body });

  try {
    const { runs } = await api.deviceHistory(device.id);
    if (runs.length === 0) {
      mount(body, h('p.muted', 'This computer has not run a sync yet.'));
      return;
    }
    mount(
      body,
      h(
        'div.table-wrap',
        h(
          'table',
          h('thead', h('tr',
            h('th', 'Started'),
            h('th', 'Status'),
            h('th.right', 'Synced'),
            h('th.right', 'Failed'),
            h('th', 'Note'))),
          h(
            'tbody',
            runs.map((run) =>
              h(
                'tr',
                h('td.nowrap', formatRelative(run.startedAt)),
                h('td', badge(
                  run.status,
                  run.status === 'done' ? 'ok' : run.status === 'error' ? 'danger' : 'warn'
                )),
                h('td.num', run.stats?.synced ?? '--'),
                h('td.num', run.stats?.failed ?? '--'),
                h('td', h('div.cell-truncate.small.muted', run.message || ''))
              )
            )
          )
        )
      )
    );
  } catch (err) {
    mount(body, notice(err.message, 'danger', 'warn'));
  }
}

// The pairing dialog. Shows a code and the server URL, and polls until the local
// app has claimed it so the user gets confirmation rather than having to guess.
async function pairDialog(onPaired) {
  const body = h('div', h('p.muted', 'Generating a code...'));
  const control = modal({ title: 'Pair a computer', body });

  try {
    // The ids that exist before the code is issued. A claim is detected as an
    // id that was not in this set, which is exact - unlike guessing from
    // timestamps, which would false-positive on a computer paired minutes ago.
    const before = new Set(
      await api
        .devices()
        .then(({ devices }) => devices.map((device) => device.id))
        .catch(() => [])
    );

    const pairing = await api.pair();

    // Grouped in fours: an eight-character code read off a screen and typed
    // into another window is much easier to keep your place in.
    const grouped = `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}`;
    const countdown = h('span.mono', '');

    mount(
      body,
      h(
        'ol',
        { style: { paddingLeft: '20px', display: 'grid', gap: '8px', margin: 0 } },
        h('li', 'Open the SyncMyPod local app on the computer your iPod plugs into.'),
        h('li', h('span', 'Enter this server address: '), h('code', pairing.serverUrl)),
        h('li', 'Enter the code below.')
      ),
      h('div.pair-code', grouped),
      h('p.small.subtle', { style: { textAlign: 'center' } },
        h('span', 'Expires in '), countdown, h('span', '. One use only.')),
      notice(
        'The code is exchanged for a token stored on that computer. Your password is never saved there, and you can revoke the token at any time.',
        '',
        'info'
      )
    );

    // Poll for the claim, and drive the countdown off the same timer.
    const expiresAt = new Date(pairing.expiresAt).getTime();
    let stopped = false;

    const tick = async () => {
      if (stopped) return;

      const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      countdown.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;

      if (remaining === 0) {
        stopped = true;
        mount(body, notice('That code expired. Close this and generate a new one.', 'warn', 'warn'));
        return;
      }

      // Checked every few seconds rather than every second: the device list is
      // a real query and this is a human-speed operation.
      if (remaining % 3 === 0) {
        try {
          const { devices } = await api.devices();
          const claimed = devices.find((device) => !before.has(device.id));
          if (claimed) {
            stopped = true;
            toast(`"${claimed.name}" is paired.`, 'ok');
            control.close();
            onPaired();
            return;
          }
        } catch {
          // A failed poll is not worth surfacing - the countdown keeps running
          // and the next attempt is a second away.
        }
      }

      setTimeout(tick, 1000);
    };

    const originalClose = control.close;
    control.close = () => {
      stopped = true;
      originalClose();
    };

    tick();
  } catch (err) {
    mount(body, notice(err.message, 'danger', 'warn'));
  }
}

function serverDetails(serverUrl) {
  const isHttps = String(serverUrl || '').startsWith('https://');
  return h(
    'div.card',
    { style: { marginTop: '24px' } },
    h('div.card-head', h('h2', 'Connection details')),
    h(
      'div.card-body',
      h(
        'dl.kv',
        h('dt', 'Server address'),
        h('dd', h('code', serverUrl || 'unknown'))
      ),
      // Pairing sends a code, and the credentials fallback sends a password.
      // Over plain HTTP both are readable in transit, so this is a real warning
      // rather than boilerplate.
      !isHttps
        ? h(
            'div',
            { style: { marginTop: '16px' } },
            notice(
              h(
                'div',
                h('strong', 'This instance is not served over HTTPS. '),
                h(
                  'span',
                  'Pairing codes and tokens travel in the clear. Acceptable on a trusted private network; put it behind HTTPS before exposing it to the internet.'
                )
              ),
              'warn',
              'warn'
            )
          )
        : null
    )
  );
}
