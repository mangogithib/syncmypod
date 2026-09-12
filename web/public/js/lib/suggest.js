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

// Where the name being typed starts and ends.
//
// The artist field holds a list - "Sadhana Sargam, Gulzar, A.R. Rahman" - and
// somebody editing it is almost always adding to or correcting ONE of those,
// not retyping the lot. Looking up the whole field found nothing, so the
// dropdown never appeared for any track that already had an artist, which is
// most of them.
//
// So the segment around the caret is what gets looked up, and what a chosen
// name replaces. Separator is a comma; "&" is left alone because it belongs
// inside names like Earth, Wind & Fire.
export function currentSegment(value, caret) {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const start = before.lastIndexOf(',') + 1;
  const relativeEnd = after.indexOf(',');
  const end = relativeEnd === -1 ? value.length : caret + relativeEnd;
  return { start, end, text: value.slice(start, end).trim() };
}

export function suggestInput({ value = '', placeholder = '', multi = false, fetchSuggestions }) {
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
    if (multi) {
      // Replace only the name being typed, keeping the rest of the list and
      // its spacing, and leave the caret after what was just inserted.
      const { start, end } = currentSegment(input.value, input.selectionStart ?? input.value.length);
      const head = input.value.slice(0, start);
      const tail = input.value.slice(end);
      const spaced = head && !head.endsWith(' ') ? `${head} ` : head;
      input.value = `${spaced}${name}${tail}`;
      const caret = spaced.length + name.length;
      close();
      input.focus();
      input.setSelectionRange(caret, caret);
    } else {
      input.value = name;
      close();
      input.focus();
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    const query = multi
      ? currentSegment(input.value, input.selectionStart ?? input.value.length).text
      : input.value.trim();
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
  // Clicking or arrowing into a different name in the list changes what should
  // be suggested, and neither fires an input event.
  if (multi) {
    input.addEventListener('click', look);
    input.addEventListener('keyup', (event) => {
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') look();
    });
  }
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
