import { clear, h, mount } from './dom.js';
import { debounce } from './ui.js';

// A text input that suggests names as you type.
//
// Used where somebody is filling in metadata by hand, which is the one place in
// this application where a typo has lasting consequences: "Arijit Singh " with
// a trailing space becomes its own artist on the Artists page, beside the real
// one, and nothing merges them afterwards. Offering the name they meant is
// cheaper than detecting the near-duplicate later.
//
// Two groups, never mixed. What is already in the library comes first, because
// picking one of those is what keeps the catalogue tidy; Deezer's suggestions
// follow, for a name the library has not seen yet.
//
// Deliberately not a <datalist>. That is less code and it renders natively on a
// phone, but it cannot say *where* a suggestion came from, and here that is the
// whole point of showing them.

export function suggestInput({ value = '', placeholder = '', fetchSuggestions }) {
  const input = h('input.input', {
    type: 'text',
    value,
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    // A native autofill dropdown on top of this one is two lists of names with
    // different contents, which is worse than either alone.
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
  });

  const list = h('div.suggest-list', { hidden: true });
  const wrap = h('div.suggest', input, list);

  let items = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (name) => {
    input.value = name;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };

  const render = (groups) => {
    clear(list);
    items = [];

    const section = (label, entries) => {
      if (entries.length === 0) return;
      list.appendChild(h('div.suggest-label', label));
      for (const entry of entries) {
        const row = h(
          'button.suggest-item',
          { type: 'button', onclick: () => choose(entry.name) },
          entry.imageUrl
            ? h('img.suggest-art', { src: entry.imageUrl, alt: '', loading: 'lazy' })
            : h('span.suggest-art.suggest-art-empty'),
          h(
            'span.suggest-text',
            h('span.suggest-name', entry.name),
            entry.subtitle ? h('span.suggest-sub', entry.subtitle) : null
          )
        );
        list.appendChild(row);
        items.push(row);
      }
    };

    section('In your library', groups.local || []);
    section('Everywhere else', groups.global || []);

    const any = items.length > 0;
    list.hidden = !any;
    input.setAttribute('aria-expanded', String(any));
    active = -1;
  };

  const look = debounce(async () => {
    const query = input.value.trim();
    if (query.length < 2) {
      close();
      return;
    }
    try {
      render(await fetchSuggestions(query));
    } catch {
      close(); // Suggestions are a convenience; typing still works without them.
    }
  }, 220);

  input.addEventListener('input', look);
  input.addEventListener('focus', () => {
    if (items.length > 0) list.hidden = false;
  });

  // A click inside the list must not close it before the button fires, so this
  // waits a tick rather than closing on blur directly.
  input.addEventListener('blur', () => setTimeout(close, 140));

  input.addEventListener('keydown', (event) => {
    if (list.hidden || items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      for (const [index, item] of items.entries()) item.classList.toggle('active', index === active);
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && active >= 0) {
      // Only when something is highlighted: otherwise Enter belongs to the form.
      event.preventDefault();
      items[active].click();
    } else if (event.key === 'Escape') {
      close();
    }
  });

  return { element: wrap, input };
}

export { mount };
