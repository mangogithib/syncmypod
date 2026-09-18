import { state as appState } from '../app.js';
import { api } from '../lib/api.js';
import { h, icon, mount } from '../lib/dom.js';
import { badge, field as uiField, modal, notice, renderAsync, toast } from '../lib/ui.js';

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

// The four providers, in the order the resolver asks them. One list, so the
// page cannot drift from itself the way it had: the server's own provider table
// in `routes/settings.js` already had all four with a working test endpoint,
// and only this page was treating them as three special cases.
const PROVIDERS = [
  {
    name: 'deezer',
    label: 'Deezer',
    order: 'Tried first',
    about:
      'Ordered artist credits and an ISRC, which is why it goes first.',
  },
  {
    name: 'itunes',
    label: 'iTunes',
    order: 'Second',
    about:
      'Strong on film and regional catalogue. Reports every artist as one string.',
  },
  {
    name: 'musicbrainz',
    label: 'MusicBrainz',
    order: 'Last fallback',
    offLabel: 'Not configured',
    offWarn: true,
    about:
      'Asked only when the other two have no answer. Needs a real contact address: it throttles clients that do not identify themselves, and blocks fake ones.',
  },
  {
    name: 'youtube',
    label: 'YouTube',
    order: 'Search and import',
    about:
      'Searching, playlist imports, and the fallback for releases the licensed catalogues have not got.',
  },
];

export async function renderSettings(view, context) {
  await renderAsync(
    view,
    () => api.settings(),
    (settings) =>
      h(
        'div.stack',
        providerCard(settings, () => renderSettings(view, context)),
        aboutCard(),
        // Last, because it is the one thing here nobody came to this page to
        // do. The old order put it above two cards of explanatory text.
        accountCard()
      )
  );

  if (!context.isCurrent()) return;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

function providerCard(data, reload) {
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

  // A checkbox for a provider that has nothing to configure but on or off.
  // Registered in `inputs` like any other field, so Save collects it the same
  // way; the value is normalised to the string the settings service stores.
  const toggle = (key) => {
    const spec = fields[key];
    if (!spec) return null;

    const input = h('input', {
      type: 'checkbox',
      checked: spec.checked,
      disabled: !spec.editable,
    });
    // A checkbox has no .value, so it is adapted to the same interface the text
    // fields present rather than special-cased in the submit handler.
    inputs.set(key, {
      input: { get value() { return input.checked ? 'true' : 'false'; } },
      spec,
    });

    return h(
      'label.checkbox',
      { style: { marginBottom: '8px' } },
      input,
      h(
        'span',
        h('div', spec.label),
        !spec.editable
          ? h('div.small.subtle', `Set by ${spec.envVar}; cannot be changed here.`)
          : null
      )
    );
  };

  // One slot per provider, keyed by name, so the rows below can be generated
  // from a list rather than written out one at a time.
  const resultSlots = Object.fromEntries(PROVIDERS.map((p) => [p.name, h('div')]));

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
      Object.values(data.providers).some(Boolean)
        ? badge('At least one active', 'ok')
        : badge('None active', 'warn')
    ),
    h(
      'div.card-body',
      h(
        'p.muted',
        { style: { marginBottom: '20px' } },
        'Every track is re-tagged against a real catalogue before it reaches the iPod. Tried in order, each asked only what the one above could not answer.'
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

        // Every provider gets the same row: name, state, one line about what
        // it is for, its configuration, and its own test. They used to be laid
        // out three different ways - Deezer and iTunes sharing a block with two
        // badges and two buttons, MusicBrainz alone with a field, YouTube alone
        // with no test at all - which made the page read as three unrelated
        // things rather than one list of four.
        //
        // Ordered the way the resolver uses them, so the page explains the
        // ladder just by being read top to bottom.
        ...PROVIDERS.map((provider) =>
          h(
            'div.provider-row',
            h(
              'div.row-between',
              h(
                'div.row',
                { style: { gap: '10px', alignItems: 'baseline' } },
                h('div.provider-name', provider.label),
                h('span.small.subtle', provider.order)
              ),
              data.providers?.[provider.name]
                ? badge('On', 'ok')
                : badge(provider.offLabel || 'Off', provider.offWarn ? 'warn' : undefined)
            ),
            h('p.small.muted.provider-about', provider.about),
            provider.name === 'musicbrainz'
              ? field('musicbrainz.contact', {
                  placeholder: 'you@example.com',
                  hint: 'An email address or a project URL. Sent in the User-Agent header on every request.',
                })
              : toggle(`${provider.name}.enabled`),
            h('div.provider-actions', testButton(provider.name, resultSlots[provider.name])),
            resultSlots[provider.name]
          )
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
  return h(
    'div.card',
    h('div.card-head', h('h2', 'Account')),
    h(
      'div.card-body',
      h(
        'dl.kv',
        { style: { marginBottom: '18px' } },
        h('dt', 'Signed in as'),
        h('dd', appState.user?.username || '--'),
        h('dt', 'Role'),
        h('dd', appState.user?.isOwner ? 'Instance owner' : 'User')
      ),
      // One button rather than three fields sitting open on the page. Changing
      // a password is rare and deliberate, and a form left permanently open
      // invites a browser to fill it in with the wrong thing.
      h(
        'button.btn',
        { type: 'button', onclick: openPasswordDialog },
        icon('settings', 14),
        'Change password'
      )
    )
  );
}

function openPasswordDialog() {
  const current = h('input.input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const statusSlot = h('div');
  const submit = h('button.btn.btn-primary', { type: 'submit' }, 'Change password');

  const form = h(
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
          dialog.close();
          toast(
            'Password changed. Other browser sessions were signed out; paired computers keep working.',
            'ok'
          );
        } catch (err) {
          mount(statusSlot, notice(err.message, 'danger', 'warn'));
        } finally {
          submit.disabled = false;
        }
      },
    },
    statusSlot,
    // `uiField` and not `field`: this module already has a `field` of its own,
    // for provider settings, with an entirely different signature.
    uiField('Current password', current),
    uiField('New password', next, { hint: 'At least 10 characters.' }),
    uiField('Confirm new password', confirm),
    // Inside the form, so Enter submits it. In the modal footer it would be a
    // button sitting outside the thing it is meant to submit.
    h('div.row', { style: { justifyContent: 'flex-end' } }, submit)
  );

  const dialog = modal({ title: 'Change password', body: form });
  current.focus();
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
        // From /api/health, which reads package.json. Hardcoded here, it went
        // on saying 0.1.0 long after that stopped being true.
        h('dd', appState.version || '--'),
        h('dt', 'Audio stored here'),
        h('dd', 'None, by design'),
        h('dt', 'Manifest version'),
        h('dd', '1')
      )
    )
  );
}
