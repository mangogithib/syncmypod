import { state as appState } from '../app.js';
import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { badge, notice, renderAsync, toast } from '../lib/ui.js';

// Settings: account, provider status, and how this instance is configured.
//
// Provider credentials are environment variables, not settings rows, so this
// page reports and explains rather than edits. That is deliberate - secrets
// belong in the deployment's own configuration, not in a database the app can
// hand back over HTTP.

export async function renderSettings(view, context) {
  await renderAsync(
    view,
    async () => {
      const [spotify, health] = await Promise.all([
        api.spotifyStatus().catch(() => null),
        api.health().catch(() => null),
      ]);
      return { spotify, health };
    },
    ({ spotify, health }) =>
      h(
        'div.stack',
        accountCard(),
        providerCard(spotify, health),
        localAppCard(),
        aboutCard()
      )
  );

  if (!context.isCurrent()) return;
}

function accountCard() {
  const current = h('input.input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const statusSlot = h('div');

  const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Change password');

  return h(
    'div.card',
    h('div.card-head', h('h2', 'Account')),
    h(
      'div.card-body',
      h(
        'dl.kv',
        { style: { marginBottom: '20px' } },
        h('dt', 'Signed in as'),
        h('dd', appState.user?.username || '--'),
        h('dt', 'Role'),
        h('dd', appState.user?.isOwner ? 'Instance owner' : 'User')
      ),
      h(
        'form.stack',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            mount(statusSlot);

            if (next.value !== confirm.value) {
              mount(statusSlot, notice('The two new passwords do not match.', 'danger', 'warn'));
              return;
            }
            if (next.value.length < 10) {
              mount(statusSlot, notice('Use at least 10 characters.', 'danger', 'warn'));
              return;
            }

            submit.disabled = true;
            try {
              await api.changePassword(current.value, next.value);
              mount(
                statusSlot,
                notice(
                  'Password changed. Other browser sessions have been signed out; paired computers keep working.',
                  '',
                  'check'
                )
              );
              current.value = next.value = confirm.value = '';
              toast('Password changed.', 'ok');
            } catch (err) {
              mount(statusSlot, notice(err.message, 'danger', 'warn'));
            } finally {
              submit.disabled = false;
            }
          },
        },
        statusSlot,
        h('div.field', h('label', 'Current password'), current),
        h('div.field', h('label', 'New password'), next, h('span.hint', 'At least 10 characters.')),
        h('div.field', h('label', 'Confirm new password'), confirm),
        h('div', submit)
      )
    )
  );
}

function providerCard(spotify, health) {
  const spotifyOn = health?.providers?.spotify ?? appState.providers.spotify;
  const musicbrainzOn = health?.providers?.musicbrainz ?? appState.providers.musicbrainz;

  return h(
    'div.card',
    h('div.card-head', h('h2', 'Metadata providers')),
    h(
      'div.card-body',
      h(
        'p.muted',
        { style: { marginBottom: '20px' } },
        'Every track is re-tagged against a real catalogue before it reaches the iPod, whatever source the audio came from. Spotify is tried first, MusicBrainz second.'
      ),

      // --- Spotify ---
      h(
        'div',
        { style: { paddingBottom: '20px', marginBottom: '20px', borderBottom: '1px solid var(--border)' } },
        h(
          'div.row-between',
          h('div', { style: { fontWeight: 600 } }, 'Spotify'),
          spotifyOn ? badge('Configured', 'ok') : badge('Not configured', 'warn')
        ),
        h(
          'p.small.muted',
          { style: { marginTop: '6px' } },
          spotifyOn
            ? 'Search and metadata resolution are using the Spotify catalogue.'
            : 'Without this, search and resolution fall back to MusicBrainz alone, which has thinner coverage and less consistent artwork.'
        ),
        h(
          'dl.kv',
          { style: { marginTop: '12px' } },
          h('dt', 'Credentials'),
          h('dd', spotifyOn ? 'Present' : h('span', h('code', 'SPOTIFY_CLIENT_ID'), ' / ', h('code', 'SPOTIFY_CLIENT_SECRET'), ' not set')),
          h('dt', 'Account linked'),
          h(
            'dd',
            spotify?.linked
              ? `Yes - ${spotify.account?.displayName || 'unknown'}`
              : h('span.subtle', 'No (needed only to import your own playlists)')
          ),
          spotify?.redirectUri ? h('dt', 'Redirect URI') : null,
          spotify?.redirectUri
            ? h(
                'dd',
                h('code', spotify.redirectUri),
                h('div.small.subtle', { style: { marginTop: '4px' } },
                  'Register this exact string on your Spotify app.')
              )
            : null
        ),
        h(
          'div.row',
          { style: { marginTop: '12px' } },
          h('a.btn.btn-sm', { href: '#/import' }, 'Import settings'),
          h(
            'a.btn.btn-sm',
            { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener noreferrer' },
            'Spotify dashboard',
            icon('link', 13)
          )
        )
      ),

      // --- MusicBrainz ---
      h(
        'div',
        h(
          'div.row-between',
          h('div', { style: { fontWeight: 600 } }, 'MusicBrainz'),
          musicbrainzOn ? badge('Configured', 'ok') : badge('Not configured', 'warn')
        ),
        h(
          'p.small.muted',
          { style: { marginTop: '6px' } },
          musicbrainzOn
            ? 'Used when Spotify has no answer.'
            : h(
                'span',
                h('span', 'MusicBrainz requires every client to identify itself. Set '),
                h('code', 'MUSICBRAINZ_CONTACT'),
                h('span', ' to an email address or project URL and restart. Sending a fake one gets the instance throttled, so the provider stays off until it is set.')
              )
        )
      )
    )
  );
}

function localAppCard() {
  return h(
    'div.card',
    h('div.card-head', h('h2', 'The local sync app')),
    h(
      'div.card-body',
      h(
        'p.muted',
        { style: { marginBottom: '16px' } },
        'This server holds library data only. Downloading audio, tagging it, writing it to the iPod and cleaning up afterwards all happen in the local app, on the computer the iPod is plugged into.'
      ),
      h(
        'div.stack',
        h(
          'div',
          h('div.small', { style: { fontWeight: 600, marginBottom: '4px' } }, 'What the local app does'),
          h(
            'ul.small.muted',
            { style: { paddingLeft: '20px', display: 'grid', gap: '4px', margin: 0 } },
            h('li', 'Pulls the manifest: every track and playlist that should be on the iPod.'),
            h('li', 'Diffs it against what is already there.'),
            h('li', 'Downloads what is missing and re-tags it from the manifest, not from the source.'),
            h('li', 'Writes the tracks and playlists to the iPod database.'),
            h('li', 'Asks before removing anything no longer in the library.'),
            h('li', 'Deletes every downloaded file once the transfer is confirmed.')
          )
        ),
        notice(
          h(
            'div',
            h('strong', 'Not built yet. '),
            h('span', 'The device API it talks to is live, and you can already pair a computer against it. '),
            h('a', { href: '#/devices' }, 'Devices')
          ),
          'accent',
          'info'
        )
      )
    )
  );
}

function aboutCard() {
  return h(
    'div.card',
    h('div.card-head', h('h2', 'About this instance')),
    h(
      'div.card-body',
      h(
        'dl.kv',
        h('dt', 'Version'),
        h('dd', '0.1.0'),
        h('dt', 'Audio stored here'),
        h('dd', 'None, by design'),
        h('dt', 'Manifest version'),
        h('dd', '1')
      )
    )
  );
}
