import { clear, h, icon, mount } from './dom.js';

// Formatting and shared UI pieces.

// mm:ss, or h:mm:ss past an hour. Used for track lengths.
export function formatDuration(ms) {
  if (!ms || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

// A human total for a library or playlist, where mm:ss stops being meaningful.
export function formatTotalDuration(ms) {
  const value = Number(ms) || 0;
  if (value === 0) return '0 min';
  const totalMinutes = Math.round(value / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (hours < 24) return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} hr`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${scaled.toFixed(scaled < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

// Relative for recent things, absolute once it stops being useful. "3 min ago"
// beats a timestamp for a sync that just ran; a date beats "412 days ago".
export function formatRelative(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'Just now';
  if (seconds < 90) return '1 min ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, kind = 'info', timeout = 4000) {
  const host = document.getElementById('toasts');
  if (!host) return;

  const node = h(
    `div.toast.toast-${kind}`,
    icon(kind === 'error' ? 'warn' : kind === 'ok' ? 'check' : 'info', 15),
    h('div', message)
  );
  host.appendChild(node);

  // Errors stay longer: they usually need reading, and sometimes copying.
  const life = kind === 'error' ? Math.max(timeout, 7000) : timeout;
  setTimeout(() => node.remove(), life);
}

// ---------------------------------------------------------------------------
// Common blocks
// ---------------------------------------------------------------------------

export function emptyState({ iconName = 'music', title, body, action }) {
  return h(
    'div.empty',
    h('div.empty-icon', icon(iconName, 30)),
    h('h3', title),
    body ? h('p', body) : null,
    action || null
  );
}

export function spinner(label = 'Loading...') {
  return h(
    'div.empty',
    h('div', { style: { display: 'grid', placeItems: 'center', gap: '12px' } },
      h('div.spinner'),
      h('p.small.muted', label))
  );
}

export function badge(text, kind) {
  return h(`span.badge${kind ? `.badge-${kind}` : ''}`, text);
}

// The metadata state of a track, as a badge. This is the status that decides
// whether a track can be synced at all, so it appears on every track row.
export function metadataBadge(state) {
  switch (state) {
    case 'resolved':
      return badge('Resolved', 'ok');
    case 'manual':
      return badge('Manual', 'accent');
    case 'unresolved':
      return badge('Unresolved', 'warn');
    default:
      return badge('Pending', 'warn');
  }
}

export function notice(message, kind = '', iconName = 'info') {
  return h(
    `div.notice${kind ? `.notice-${kind}` : ''}`,
    icon(iconName, 16),
    h('div', message)
  );
}

// Album art, falling back to a placeholder glyph. Artwork is loaded straight
// from the provider CDN, so a broken or blocked image must not leave a gap.
export function artwork(url, { size = 36, large = false, round = false } = {}) {
  // Artists are circles and records are squares, the way every music interface
  // has drawn them since the CD booklet.
  const className =
    (large ? 'thumb thumb-lg' : 'thumb') + (round ? ' thumb-round' : '');
  if (!url) {
    return h(
      `div.${className.split(' ').join('.')}.thumb-placeholder`,
      { style: large ? {} : { width: `${size}px`, height: `${size}px` } },
      icon('music', large ? 28 : 15)
    );
  }
  const img = h('img', {
    class: className,
    src: url,
    alt: '',
    loading: 'lazy',
    width: large ? undefined : size,
    height: large ? undefined : size,
  });
  img.addEventListener('error', () => {
    img.replaceWith(artwork(null, { size, large }));
  });
  return img;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

// A modal with focus handling and Escape to close. Returns { close }.
export function modal({ title, body, footer, onClose, wide = false }) {
  const previousFocus = document.activeElement;

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown);
    // Returning focus is what makes a modal usable from the keyboard: without
    // it, closing one drops focus back to the top of the document.
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    onClose?.();
  };

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  const dialog = h(
    'div.modal',
    {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      style: wide ? { maxWidth: '760px' } : {},
      onclick: (event) => event.stopPropagation(),
    },
    h(
      'div.modal-head',
      h('h2', title),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x', 17))
    ),
    h('div.modal-body', body),
    footer ? h('div.modal-foot', footer) : null
  );

  // Clicking the backdrop closes; the click handler on the dialog above stops
  // a click inside from bubbling out to it.
  const backdrop = h('div.modal-backdrop', { onclick: close }, dialog);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKeydown);

  const focusTarget = dialog.querySelector(
    'input, select, textarea, button.btn-primary, button'
  );
  focusTarget?.focus();

  return { close, dialog };
}

// A yes/no prompt. Used before anything destructive - removing a track,
// deleting a playlist, revoking a device.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const control = modal({
      title,
      body: h('p', message),
      footer: [
        h('button.btn', { type: 'button', onclick: () => { finish(false); control.close(); } }, 'Cancel'),
        h(
          `button.btn.${danger ? 'btn-danger' : 'btn-primary'}`,
          { type: 'button', onclick: () => { finish(true); control.close(); } },
          confirmLabel
        ),
      ],
      // Covers Escape and the backdrop, which must both count as "no".
      onClose: () => finish(false),
    });
  });
}

// ---------------------------------------------------------------------------
// Async view helper
// ---------------------------------------------------------------------------

// Renders a spinner, awaits the loader, then renders the result - or the error.
// Every view uses this, so loading and failure look the same everywhere and no
// view has to hand-roll it.
export async function renderAsync(container, loader, render) {
  mount(container, spinner());
  try {
    const data = await loader();
    clear(container);
    const output = render(data);
    mount(container, output);
  } catch (err) {
    // A 401 is already being handled globally by api.js, so showing an error
    // panel here as well would just flash on the way to the login screen.
    if (err.status === 401) return;
    mount(
      container,
      notice(
        h('div', h('strong', 'Could not load this page. '), h('span', err.message)),
        'danger',
        'warn'
      ),
      h(
        'button.btn',
        { type: 'button', onclick: () => renderAsync(container, loader, render) },
        'Try again'
      )
    );
  }
}

// Waits until typing stops. Search boxes hit provider APIs, so firing per
// keystroke would be both slow and a good way to get rate limited.
export function debounce(fn, wait = 320) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
