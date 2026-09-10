import { state as appState } from '../app.js';
import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { badge, notice, renderAsync, toast } from '../lib/ui.js';

// Settings: account, provider configuration, and instance information.
//
// Provider credentials are editable here rather than only in a .env file, which
// for a self-hosted tool is the difference between a setting being adjustable
// and being effectively frozen behind SSH access and a container restart.
//
// Two rules the UI has to make visible:
//
//   * A value set in the environment WINS and cannot be edited here. The field
//     is disabled and says which variable owns it, rather than accepting an
//     edit and appearing to lose it.
//   * A secret is never sent back to the browser. The field shows a short hint
//     and blank means "leave unchanged", so saving the form does not wipe a
//     secret the user never typed.

export async function renderSettings(view, context) {
  await renderAsync(
    view,
    async () => {
      const [settings, spotifyLink] = await Promise.all([
        api.settings(),
        api.spotifyStatus().catch(() => null),
      ]);
      return { settings, spotifyLink };
    },
    ({ settings, spotifyLink }) =>
      h(
        'div.stack',
        providerCard(settings, spotifyLink, () => renderSettings(view, context)),
        accountCard(),
        localAppCard(),
        aboutCard()
      )
  );

  if (!context.isCurrent()) return;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

function providerCard(data, spotifyLink, reload) {
  const fields = data.settings;
  // key -> input element, so Save can collect only what changed.
  const inputs = new Map();

  const field = (key, { placeholder, hint, type = 'text' } = {}) => {
    const spec = fields[key];
    if (!spec) return null;

    const input = h('input.input', {
      type,
      placeholder: spec.secret && spec.isSet ? 'Leave blank to keep current' : placeholder || '',
      value: spec.secret ? '' : spec.value || '',
      disabled: !spec.editable,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    inputs.set(key, { input, spec });

    return h(
      'div.field',
      h('label', spec.label),
      input,
      !spec.editable
        ? h(
            'span.hint',
            h('span', 'Set by the '),
            h('code', spec.envVar),
            h('span', ' environment variable, so it cannot be changed here. Remove it from .env to edit it in this page.')
          )
        : spec.secret && spec.isSet
          ? h('span.hint', `Currently set (${spec.hint}). Blank leaves it unchanged.`)
          : hint
            ? h('span.hint', hint)
            : null
    );
  };

  const spotifyResult = h('div');
  const musicbrainzResult = h('div');

  const testButton = (provider, slot) =>
    h(
      'button.btn.btn-sm',
      {
        type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Testing...';
          mount(slot);
          try {
            const result = await api.testProvider(provider);
            mount(
              slot,
              notice(
                h(
                  'div',
                  h('strong', result.ok ? 'Working. ' : 'Not working. '),
                  h('span', result.message),
                  // The provider's own error text is the most useful thing to
                  // show, but it usually needs translating into an action.
                  result.hint ? h('div', { style: { marginTop: '6px' } }, result.hint) : null
                ),
                result.ok ? '' : 'warn',
                result.ok ? 'check' : 'warn'
              )
            );
          } catch (err) {
            mount(slot, notice(err.message, 'danger', 'warn'));
          } finally {
            button.disabled = false;
            button.textContent = 'Test connection';
          }
        },
      },
      icon('refresh', 14),
      'Test connection'
    );

  const save = h('button.btn.btn-primary', { type: 'submit' }, 'Save settings');
  const saveResult = h('div');

  return h(
    'div.card',
    h(
      'div.card-head',
      h('h2', 'Metadata providers'),
      h('div.spacer'),
      data.providers.spotify || data.providers.musicbrainz
        ? badge('At least one active', 'ok')
        : badge('None active', 'warn')
    ),
    h(
      'div.card-body',
      h(
        'p.muted',
        { style: { marginBottom: '20px' } },
        'Every track is re-tagged against a real catalogue before it reaches the iPod, whatever source the audio came from. Spotify is tried first, MusicBrainz second.'
      ),
      h(
        'form.stack',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            mount(saveResult);

            const updates = {};
            for (const [key, { input, spec }] of inputs) {
              if (!spec.editable) continue;
              const value = input.value.trim();
              // A blank secret field means "keep what is stored", not "clear
              // it". Clearing a secret is done by removing it deliberately, not
              // by submitting a form without retyping it.
              if (spec.secret && value === '') continue;
              updates[key] = value;
            }

            if (Object.keys(updates).length === 0) {
              mount(saveResult, notice('Nothing to change.', '', 'info'));
              return;
            }

            save.disabled = true;
            try {
              const result = await api.saveSettings(updates);
              if (result.rejected.length > 0) {
                mount(
                  saveResult,
                  notice(
                    h(
                      'div',
                      h('strong', 'Some settings were not applied: '),
                      ...result.rejected.map((entry) => h('div', entry.reason))
                    ),
                    'warn',
                    'warn'
                  )
                );
              } else {
                toast('Settings saved. They take effect immediately.', 'ok');
              }
              appState.providers = result.providers;
              reload();
            } catch (err) {
              mount(saveResult, notice(err.message, 'danger', 'warn'));
            } finally {
              save.disabled = false;
            }
          },
        },
        saveResult,

        // --- Spotify -------------------------------------------------------
        h(
          'div',
          { style: { paddingBottom: '20px', borderBottom: '1px solid var(--border)' } },
          h(
            'div.row-between',
            { style: { marginBottom: '10px' } },
            h('div', { style: { fontWeight: 600 } }, 'Spotify'),
            data.providers.spotify ? badge('Configured', 'ok') : badge('Not configured', 'warn')
          ),
          h(
            'p.small.muted',
            { style: { marginBottom: '14px' } },
            h('span', 'Create an app at '),
            h(
              'a',
              {
                href: 'https://developer.spotify.com/dashboard',
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              'developer.spotify.com/dashboard'
            ),
            h('span', '. The Client ID and Secret alone enable search and metadata resolution; the Redirect URI is needed only to import your own playlists.')
          ),
          field('spotify.clientId', { placeholder: '32-character client id' }),
          field('spotify.clientSecret', { placeholder: '32-character client secret', type: 'password' }),
          field('spotify.redirectUri', {
            placeholder: spotifyLink?.redirectUri || 'https://your-domain/api/import/spotify/callback',
            hint: 'Must match a Redirect URI registered on your Spotify app exactly. Leave blank to derive it from the address you are using.',
          }),
          field('spotify.market', {
            placeholder: 'blank',
            hint: 'Optional two-letter country code. Blank returns everything, which is normally what you want here - this tool only reads metadata, so playability in a given country is irrelevant.',
          }),
          h('div.row', { style: { marginTop: '12px' } }, testButton('spotify', spotifyResult)),
          spotifyResult
        ),

        // --- MusicBrainz ---------------------------------------------------
        h(
          'div',
          h(
            'div.row-between',
            { style: { marginBottom: '10px' } },
            h('div', { style: { fontWeight: 600 } }, 'MusicBrainz'),
            data.providers.musicbrainz
              ? badge('Configured', 'ok')
              : badge('Not configured', 'warn')
          ),
          h(
            'p.small.muted',
            { style: { marginBottom: '14px' } },
            'Used when Spotify has no answer. MusicBrainz requires every client to identify itself with a contactable address and throttles those that do not, so this stays off until one is set - sending a fake one gets the instance blocked.'
          ),
          field('musicbrainz.contact', {
            placeholder: 'you@example.com',
            hint: 'An email address or a project URL. Sent in the User-Agent header on every MusicBrainz request.',
          }),
          h('div.row', { style: { marginTop: '12px' } }, testButton('musicbrainz', musicbrainzResult)),
          musicbrainzResult
        ),

        h('div', { style: { marginTop: '4px' } }, save)
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Informational
// ---------------------------------------------------------------------------

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
