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
//     covered in empty boxes. Shift extends from the last row touched;
//     ctrl/cmd toggles one without disturbing the rest. That is the convention
//     every file manager and mail client already taught people.
//   * With a touch screen there is no hover and no shift key, so a long press
//     is what starts a selection - and once started, dragging a finger down the
//     list extends it. The press has to be held rather than tapped, or every
//     scroll would select something.
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

  const sync = () => {
    for (const [key, { row, box }] of rows) {
      const on = ids.has(key);
      row.classList.toggle('row-selected', on);
      if (box.checked !== on) box.checked = on;
    }
  };

  const notify = () => {
    sync();
    onChange?.(api);
  };

  const api = {
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

    selectAll() {
      for (const id of order) ids.add(id);
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

      if (ids.has(key) && (additive || touchMode || ids.size > 1)) {
        ids.delete(key);
      } else if (additive || touchMode || ids.size > 0) {
        ids.add(key);
      } else {
        ids.add(key);
      }
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
  };

  return api;
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
    onclick: (event) => {
      event.stopPropagation();
      selection.toggle(key, { additive: true });
    },
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

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  row.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        // Haptics where the browser offers them: a long press with no feedback
        // feels like nothing happened until the row changes.
        navigator.vibrate?.(12);
        selection.beginTouch(key);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

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
      if (!selection.touchMode) return;
      // Which row is under the finger now. elementFromPoint rather than
      // tracking geometry, because the list can be any shape and this is what
      // the browser already knows.
      const under = document.elementFromPoint(touch.clientX, touch.clientY);
      const overRow = under?.closest('[data-select-id]');
      if (overRow?.dataset.selectId) selection.extendTouch(overRow.dataset.selectId);
    },
    { passive: true }
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
// Rendered into a fixed host at the foot of the view rather than pushed in
// above the list: it must not move the rows you are selecting, and on a phone
// it wants to be within reach of a thumb.
export function selectionBar(host, selection, { actions, total, onRender }) {
  // A class on the view rather than per-row state: it turns every checkbox
  // visible at once and stops a long press selecting the text under the finger,
  // and both of those are properties of the list being in selection mode.
  document.querySelector('#view')?.classList.toggle('selecting', selection.size > 0);

  if (selection.size === 0) {
    mount(host);
    host.hidden = true;
    return;
  }

  host.hidden = false;
  mount(
    host,
    h(
      'div.selection-bar',
      h(
        'div.selection-count',
        h('strong', String(selection.size)),
        h('span', ` selected${total ? ` of ${total}` : ''}`)
      ),
      h(
        'div.selection-actions',
        // Select-all is here rather than as a header checkbox: it belongs with
        // the other things you can do to a selection, and a header checkbox on
        // a paged list is a promise it cannot keep - it can only ever mean
        // "this page".
        selection.size < (total ?? 0)
          ? h(
              'button.btn.btn-sm.btn-ghost',
              {
                type: 'button',
                onclick: () => {
                  selection.selectAll();
                  onRender?.();
                },
              },
              'Select page'
            )
          : null,
        ...actions,
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
}
