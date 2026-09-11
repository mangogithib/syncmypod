// A very small DOM helper, in place of a framework.
//
// The whole point of this file is that nothing in the app builds markup by
// concatenating strings. Track titles, artist names and playlist names all come
// from external APIs and from user input, and h() sets text through
// textContent, so there is no path by which any of it can be interpreted as
// HTML. That removes XSS as a category rather than relying on remembering to
// escape in a hundred template literals.

const SVG_NS = 'http://www.w3.org/2000/svg';

// h('div.card', { onclick: fn }, 'text', childNode, [more, children])
//
// The tag accepts a CSS-ish shorthand: 'button.btn.btn-primary' or 'span#total'.
export function h(spec, props, ...children) {
  const [tagAndId, ...classes] = String(spec).split('.');
  const [tag, id] = tagAndId.split('#');

  // SVG must be created in its own namespace. document.createElement('svg')
  // silently produces an HTMLUnknownElement that renders nothing at all, which
  // is a genuinely baffling failure to debug - the element is in the DOM, has
  // the right attributes, and simply does not appear.
  const isSvg = tag === 'svg';
  const el = isSvg
    ? document.createElementNS(SVG_NS, 'svg')
    : document.createElement(tag || 'div');

  if (id) el.id = id;
  // className on an SVG element is a read-only SVGAnimatedString, so the class
  // has to go through setAttribute.
  if (classes.length > 0) {
    if (isSvg) el.setAttribute('class', classes.join(' '));
    else el.className = classes.join(' ');
  }

  // A second argument that is not a plain props object is treated as a child,
  // so h('p', 'text') works as expected.
  let attrs = props;
  if (
    props === null ||
    props === undefined ||
    typeof props !== 'object' ||
    props instanceof Node ||
    Array.isArray(props)
  ) {
    if (props !== null && props !== undefined) children.unshift(props);
    attrs = null;
  }

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class' || key === 'className') {
      if (isSvg) {
        el.setAttribute('class', [el.getAttribute('class'), value].filter(Boolean).join(' '));
      } else {
        el.className = [el.className, value].filter(Boolean).join(' ');
      }
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'html') {
      // Only ever used with markup this app authored itself - inline SVG icons.
      // Never with anything from an API or an input. Because the parent is in
      // the SVG namespace, its children parse into that namespace too.
      el.innerHTML = value;
    } else if (isSvg) {
      // SVG properties are not assignable the way HTML ones are, and attribute
      // names like stroke-width are not valid identifiers, so everything goes
      // through setAttribute.
      el.setAttribute(key, value === true ? '' : String(value));
    } else if (key in el && key !== 'list' && typeof value !== 'object') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      // Text, always. This is the line that makes injection impossible.
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

// An inline SVG icon. The path data is a literal in icons.js, never user input.
export function icon(name, size = 16) {
  const path = ICONS[name];
  if (!path) return null;
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    html: path,
  });
}

// Kept minimal and hand-written rather than pulling in an icon library, which
// would be a build step and a dependency for a dozen glyphs.
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  music: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 18V5l12-2v13"/>',
  album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  list: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="M18 13v6"/><circle cx="19.5" cy="19" r="1.6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M4 19.5h16"/>',
  device: '<rect x="6" y="2" width="12" height="20" rx="3"/><circle cx="12" cy="15" r="3.2"/><path d="M9.5 6h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 4.5V11h-6"/>',
  check: '<path d="m5 13 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.7" fill="currentColor"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 7.5 13 5.5a4 4 0 0 1 5.6 5.6l-2 2"/><path d="M13 16.5 11 18.5A4 4 0 0 1 5.4 13l2-2"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  star: '<path d="m12 4 2.4 5.2 5.6.7-4.1 3.9 1.1 5.6L12 16.7l-5 2.7 1.1-5.6L4 9.9l5.6-.7z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-9.5A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.9C19.5 15.4 12 20 12 20z"/>',
};
