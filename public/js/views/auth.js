import { api } from '../lib/api.js';
import { h, mount } from '../lib/dom.js';
import { notice, toast } from '../lib/ui.js';

// Login, and the first-run screen that creates the owner account.
//
// Kept in one file because they are the same form with a different verb, and
// because which one is shown is decided by the server (needsSetup), not by
// anything the user picks.

export function renderAuth(host, { needsSetup, onSignedIn }) {
  const isSetup = Boolean(needsSetup);

  const errorSlot = h('div');
  const username = h('input.input', {
    type: 'text',
    id: 'username',
    autocomplete: 'username',
    required: true,
    autocapitalize: 'none',
    spellcheck: 'false',
  });
  const password = h('input.input', {
    type: 'password',
    id: 'password',
    // A new-password field tells a password manager to offer to generate one,
    // which is the right prompt on the setup screen and the wrong one on login.
    autocomplete: isSetup ? 'new-password' : 'current-password',
    required: true,
  });
  const confirm = isSetup
    ? h('input.input', { type: 'password', id: 'confirm', autocomplete: 'new-password', required: true })
    : null;

  const submit = h(
    'button.btn.btn-primary',
    { type: 'submit', style: { width: '100%' } },
    isSetup ? 'Create account' : 'Sign in'
  );

  const onSubmit = async (event) => {
    event.preventDefault();
    mount(errorSlot);

    const usernameValue = username.value.trim();
    const passwordValue = password.value;

    if (!usernameValue || !passwordValue) {
      mount(errorSlot, notice('Enter a username and password.', 'danger', 'warn'));
      return;
    }
    // Checked here as well as server-side, because catching a typo before the
    // account exists is much kinder than after.
    if (isSetup && passwordValue !== confirm.value) {
      mount(errorSlot, notice('The two passwords do not match.', 'danger', 'warn'));
      return;
    }
    if (isSetup && passwordValue.length < 10) {
      mount(errorSlot, notice('Use a password of at least 10 characters.', 'danger', 'warn'));
      return;
    }

    submit.disabled = true;
    submit.textContent = isSetup ? 'Creating...' : 'Signing in...';

    try {
      if (isSetup) {
        await api.setup(usernameValue, passwordValue);
        toast('Account created. Welcome to SyncMyPod.', 'ok');
      } else {
        await api.login(usernameValue, passwordValue);
      }
      onSignedIn();
    } catch (err) {
      mount(errorSlot, notice(err.message, 'danger', 'warn'));
      submit.disabled = false;
      submit.textContent = isSetup ? 'Create account' : 'Sign in';
      password.value = '';
      password.focus();
    }
  };

  mount(
    host,
    h(
      'div.auth-card',
      h(
        'div.auth-brand',
        h('svg', {
          viewBox: '0 0 24 24',
          width: 24,
          height: 24,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'aria-hidden': 'true',
          html:
            '<rect x="5" y="2" width="14" height="20" rx="3"/>' +
            '<circle cx="12" cy="15.5" r="3.6"/><path d="M8.5 6h7"/>',
        }),
        h('span', 'SyncMyPod')
      ),
      h('h1', isSetup ? 'Set up this instance' : 'Sign in'),
      h(
        'p.auth-sub',
        isSetup
          ? 'This is a fresh instance. Create the account that will own it.'
          : 'Your library is private to this server.'
      ),
      errorSlot,
      h(
        'form.auth-form',
        { onsubmit: onSubmit },
        h('div.field', h('label', { for: 'username' }, 'Username'), username),
        h(
          'div.field',
          h('label', { for: 'password' }, 'Password'),
          password,
          isSetup ? h('span.hint', 'At least 10 characters.') : null
        ),
        confirm
          ? h('div.field', h('label', { for: 'confirm' }, 'Confirm password'), confirm)
          : null,
        submit
      ),
      isSetup
        ? h(
            'p.small.subtle',
            { style: { marginTop: '16px', textAlign: 'center' } },
            'Only one account can be created this way. After that, this screen becomes a sign-in form.'
          )
        : null
    )
  );

  username.focus();
}
