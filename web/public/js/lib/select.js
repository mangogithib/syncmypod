import { h, icon, mount } from './dom.js';

// Selecting several rows at once, and the bar of actions that appears when you
// have.
//
// One module rather than per-view code, because the interaction is the hard
// part and it is identical everywhere: what differs between Songs and a
// playlist is only which actions the bar offers.
//
// **Two ways in, because a mouse and a thumb want different things.**
//
//   * With a pointer, rows carry a checkbox. It is invisible until the row is
//     hovered or something is selected, so a list you are only reading is not
//     covered in empty boxes. Shift extends from the last row touched - on the
//     row OR on its checkbox, which is the one people actually aim at;
//     ctrl/cmd toggles one without disturbing the rest.
//   * With a touch screen there is no hover and no shift key, so a long press
//     is what starts a selection - and once started, dragging that same finger
//     down the list extends it without the page scrolling underneath.
//
// **Select-all lives in the column header.** It appears once a selection has
// started and takes the whole list with one press, which is where every mail
// client and file manager has put it. It was a "Select page" button in the
// action bar, which is neither where anyone looks for it nor a name anyone
// recognises.
//
// **Selection survives a re-render but not a reload.** The ids live here and
// the rows are rebuilt from them, so removing forty tracks and re-rendering
// leaves the bar in a sensible state. Navigating away drops it, which is right:
// a selection is about what you are doing now.

const LONG_PRESS_MS = 400;
// A finger that moves more than this before the timer fires is scrolling, not
// pressing. Measured in CSS pixels.
const LONG_PRESS_SLOP = 10;

export function createSelection({ onChange } = {}) {
  const ids = new Set();
  // Where a shift-click or a drag measures from: the last row deliberately
  // touched, not the lowest-numbered one.
  let anchor = null;
  // Only true once a selection has been started on a touch screen. It is what
  // makes a plain tap select instead of navigate, and it goes away with the
  // last selected row.
  let touchMode = false;
  // Set by the view on every render, so shift and drag know what "between" is.
  let order = [];
  // key -> { row, box } for the rows currently on screen.
  //
  // Without this, toggling a checkbox had to re-run the view's loader to repaint
  // the row - a request and a full table rebuild to tick one box, which also
  // threw away the scroll position. Shift-selecting forty rows changes forty
  // rows, so the sync has to be able to reach all of them.
  const rows = new Map();
  // The header checkbox, when the view has one. Kept here so its tri-state
  // follows the selection without the view having to drive it.
  let headerBox = null;

  const sync = () => {
    for (const [key, { row, box }] of rows) {
      const on = ids.has(key);
      row.classList.toggle('row-selected', on);
      if (box.checked !== on) box.checked = on;
    }
    if (headerBox) {
      const onPage = order.filter((id) => ids.has(id)).length;
      headerBox.checked = order.length > 0 && onPage === order.length;
      // Partly selected reads as neither on nor off, which is exactly what it
      // is - and it makes one press mean "take the rest" rather than guessing.
      headerBox.indeterminate = onPage > 0 && onPage < order.length;
    }
  };

  const notify = () => {
    sync();
    onChange?.(handle);
  };

  const handle = {
    get size() {
      return ids.size;
    },
    get ids() {
      return [...ids];
    },
    get touchMode() {
      return touchMode;
    },
    has: (id) => ids.has(id),

    // The ids currently on screen, in the order they appear. Shift-clicking
    // from row 3 to row 40 needs to know what lies between them, and only the
    // view knows that.
    setOrder(next) {
      order = next.map(String);
    },

    // Called by `selectable` as each row is built. The map is rebuilt with the
    // list, so rows from a previous page are not left behind in it.
    register(key, row, box) {
      rows.set(String(key), { row, box });
    },

    // Called before a list is rebuilt. The row registry goes, because those
    // nodes are about to be thrown away and keeping them would leak one per
    // page turn.
    //
    // The header box deliberately does not. A view that rebuilds only its rows
    // - a playlist redrawn after a removal - keeps the same header, and
    // clearing the reference here left it in the DOM with nothing updating its
    // tri-state. A view that does rebuild its header replaces this reference
    // when it asks for a new one.
    resetRows() {
      rows.clear();
    },

    clear() {
      if (ids.size === 0 && !touchMode) return;
      ids.clear();
      anchor = null;
      touchMode = false;
      notify();
    },

    // Every row currently listed. "All" means the list in front of you, which
    // is what a header checkbox can honestly promise - a paged list's other
    // pages are not on screen and are not being acted on.
    selectAll() {
      for (const id of order) ids.add(id);
      notify();
    },

    // What the header checkbox does: take the whole list, or let it all go.
    toggleAll() {
      const onPage = order.filter((id) => ids.has(id)).length;
      if (onPage === order.length) {
        for (const id of order) ids.delete(id);
        if (ids.size === 0) touchMode = false;
      } else {
        for (const id of order) ids.add(id);
      }
      anchor = null;
      notify();
    },

    toggle(id, { extend = false, additive = false } = {}) {
      const key = String(id);

      if (extend && anchor !== null) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(key);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          // Extending adds; it never clears what is already held. Shift-click
          // in a mail client does the same, and the alternative loses a
          // selection built up by hand.
          for (let i = lo; i <= hi; i++) ids.add(order[i]);
          anchor = key;
          notify();
          return;
        }
      }

      if (ids.has(key)) ids.delete(key);
      else ids.add(key);

      anchor = ids.has(key) ? key : null;
      if (ids.size === 0) touchMode = false;
      notify();
    },

    // Called by the long-press handler. Starting a touch selection and
    // selecting the pressed row are one action, not two.
    beginTouch(id) {
      touchMode = true;
      ids.add(String(id));
      anchor = String(id);
      notify();
    },

    // A finger dragged over a row while a touch selection is active.
    extendTouch(id) {
      if (!touchMode || anchor === null) return;
      const from = order.indexOf(anchor);
      const to = order.indexOf(String(id));
      if (from === -1 || to === -1) return;
      const [lo, hi] = from < to ? [from, to] : [to, from];
      let changed = false;
      for (let i = lo; i <= hi; i++) {
        if (!ids.has(order[i])) {
          ids.add(order[i]);
          changed = true;
        }
      }
      if (changed) notify();
    },

    // The header checkbox, for the view to put in its `th`. Hidden until a
    // selection exists: an always-present one on a list nobody is selecting
    // from is a control asking to be pressed by accident.
    headerCheckbox({ label = 'Select all' } = {}) {
      const box = h('input.row-check.row-check-all', {
        type: 'checkbox',
        'aria-label': label,
        title: label,
        onclick: (event) => {
          event.stopPropagation();
          handle.toggleAll();
        },
      });
      headerBox = box;
      sync();
      return box;
    },
  };

  return handle;
}

// The header checkbox for a list that has no column headings to put it in.
//
// A table has a `thead` and the box goes in the first cell of it. A flex list -
// an album grid's list view, a playlist - has nothing above the rows at all, so
// select-all had nowhere to live and those lists could only be selected one row
// at a time. This is that missing strip: the box, and a count beside it.
//
// It follows the same rule as a row's own box. Invisible on a list nobody is
// selecting from, revealed on hover so it can be found, and shown throughout
// once a selection is running.
export function selectAllRow(selection, { total, label = 'Select all' } = {}) {
  return h(
    'div.list-head',
    h('span.check-cell', selection.headerCheckbox({ label })),
    h('span.list-head-label', total ? `${total} in this list` : '')
  );
}

// Makes one row selectable. Returns the checkbox to put at the head of it.
//
// The row element is given the handlers rather than the checkbox alone, so the
// whole row responds to shift-click and to a long press - clicking a 14px box
// is not the interaction, it is the indicator.
export function selectable(row, id, selection) {
  const key = String(id);

  const box = h('input.row-check', {
    type: 'checkbox',
    checked: selection.has(key),
    'aria-label': 'Select row',
    // The row's own handler would otherwise fire as well and toggle twice.
    //
    // Shift is read here as well as on the row. It used to force `additive`,
    // so shift-clicking the checkbox - which is what the box is there to
    // invite - toggled one row and never extended a range. Ticking row 1 and
    // shift-ticking row 40 selected two songs out of forty.
    onclick: (event) => {
      event.stopPropagation();
      selection.toggle(key, { extend: event.shiftKey, additive: !event.shiftKey });
    },
  });

  // Shift-clicking otherwise selects the text between the two rows, which
  // leaves the list highlighted blue under the selection it just made. The
  // range still gets selected; this only stops the browser's own drag.
  row.addEventListener('mousedown', (event) => {
    if (event.shiftKey) event.preventDefault();
  });

  row.addEventListener('click', (event) => {
    // Let a link or a button inside the row be itself.
    if (event.target.closest('a, button, input, select, textarea')) return;

    const extend = event.shiftKey;
    const additive = event.ctrlKey || event.metaKey;
    if (!extend && !additive && !selection.size) return; // a plain click on an idle list

    event.preventDefault();
    selection.toggle(key, { extend, additive });
  });

  // --- touch ---------------------------------------------------------------

  let timer = null;
  let startY = 0;
  let startX = 0;
  // True from the moment a long press starts a selection until that finger
  // lifts. It is what tells the move handler this gesture is a drag-select and
  // not a scroll, and it has to be per-gesture: once a selection exists, an
  // ordinary swipe somewhere else in the list must still scroll the page.
  let dragging = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    dragging = false;
  };

  row.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      dragging = false;
      timer = setTimeout(() => {
        timer = null;
        dragging = true;
        // Haptics where the browser offers them: a long press with no feedback
        // feels like nothing happened until the row changes.
        navigator.vibrate?.(12);
        selection.beginTouch(key);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  // Deliberately NOT passive.
  //
  // This is the whole reason dragging a finger down the list scrolled the page
  // instead of selecting rows: a passive listener may not call
  // preventDefault(), so the browser scrolled while this quietly tried to
  // extend a selection that was moving out from under it. Non-passive costs a
  // little scroll responsiveness on this element and buys the gesture.
  row.addEventListener(
    'touchmove',
    (event) => {
      const touch = event.touches[0];
      if (!touch) return;

      if (
        timer &&
        (Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP ||
          Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP)
      ) {
        cancel(); // the finger is scrolling
        return;
      }

      if (!dragging || !selection.touchMode) return;

      // The page must hold still while the finger is picking rows.
      if (event.cancelable) event.preventDefault();

      // Which row is under the finger now. elementFromPoint rather than
      // tracking geometry, because the list can be any shape and this is what
      // the browser already knows.
      const under = document.elementFromPoint(touch.clientX, touch.clientY);
      const overRow = under?.closest('[data-select-id]');
      if (overRow?.dataset.selectId) selection.extendTouch(overRow.dataset.selectId);
    },
    { passive: false }
  );

  row.addEventListener('touchend', cancel, { passive: true });
  row.addEventListener('touchcancel', cancel, { passive: true });

  row.dataset.selectId = key;
  if (selection.has(key)) row.classList.add('row-selected');
  selection.register(key, row, box);
  return box;
}

// The bar that appears once something is selected.
//
// Rendered into a fixed host rather than pushed in above the list: it must not
// move the rows you are selecting, and on a phone it wants to be within reach
// of a thumb.
//
// `hosts` takes one element or several. Two is the normal case - one sticky at
// the top of the list and one at the foot - because a selection made at the
// bottom of four hundred rows should not need a scroll back up to act on, and
// neither should one made at the top.
export function selectionBar(hosts, selection, { actions, total, onRender }) {
  const all = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);

  // A class on the view rather than per-row state: it turns every checkbox
  // visible at once and stops a long press selecting the text under the finger,
  // and both of those are properties of the list being in selection mode.
  document.querySelector('#view')?.classList.toggle('selecting', selection.size > 0);

  if (selection.size === 0) {
    for (const host of all) {
      mount(host);
      host.hidden = true;
    }
    return;
  }

  // Each host gets its own nodes. The same element cannot be in two places, and
  // a shared action button would move from one bar to the other.
  all.forEach((host, index) => {
    host.hidden = false;
    mount(
      host,
      h(
        `div.selection-bar${index === 0 && all.length > 1 ? '.selection-bar-top' : ''}`,
        h(
          'div.selection-count',
          h('strong', String(selection.size)),
          h('span', ` selected${total ? ` of ${total}` : ''}`)
        ),
        h(
          'div.selection-actions',
          ...actions.map((make) => (typeof make === 'function' ? make() : make)),
          h(
            'button.btn.btn-sm.btn-ghost',
            {
              type: 'button',
              'aria-label': 'Clear selection',
              onclick: () => {
                selection.clear();
                onRender?.();
              },
            },
            icon('x', 14),
            'Cancel'
          )
        )
      )
    );
  });
}
