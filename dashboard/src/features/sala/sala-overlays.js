// One stack for every panel that sits over the refuge (agent, board, help, team desk).
// Escape closes the top one, focus goes back to what opened it, and openers keep
// aria-expanded in sync. Entries sharing a `slot` replace each other.

/** @param {{ onChange?: (list: string[]) => void }} options */
export function createOverlayStack({ onChange = () => {} } = {}) {
  /** @type {{ id: string, slot?: string, close: () => void, returnFocus?: () => any, fallbackFocus?: () => any, controls?: () => any[] }[]} */
  let entries = [];
  const expand = (entry, value) => {
    for (const el of entry.controls?.() || [])
      el?.setAttribute("aria-expanded", String(value));
  };
  const notify = () => onChange(entries.map((e) => e.id));
  const focusBack = (entry) => {
    const target = entry.returnFocus?.();
    if (target?.isConnected !== false && target?.focus) target.focus();
    else entry.fallbackFocus?.()?.focus?.();
  };
  function remove(id, { restoreFocus }) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return false;
    entries = entries.filter((e) => e !== entry);
    entry.close();
    expand(entry, false);
    if (restoreFocus) focusBack(entry);
    return true;
  }
  return {
    open(id, options) {
      const previous = entries.find((e) => e.id === id);
      if (previous) entries = entries.filter((e) => e !== previous);
      const rival =
        options.slot && entries.find((e) => e.slot === options.slot);
      if (rival) remove(rival.id, { restoreFocus: false });
      const entry = { ...previous, ...options, id };
      entries.push(entry);
      expand(entry, true);
      notify();
    },
    /** Closes a specific overlay (its own close button). */
    close(id, { restoreFocus = true } = {}) {
      const done = remove(id, { restoreFocus });
      if (done) notify();
      return done;
    },
    /** Escape: closes the overlay on top. Returns false when nothing was open. */
    closeTop() {
      const top = entries.at(-1);
      return top ? this.close(top.id) : false;
    },
    /** Forget an overlay that already hid itself, without calling its close. */
    forget(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      entries = entries.filter((e) => e !== entry);
      expand(entry, false);
      notify();
    },
    top: () => entries.at(-1)?.id ?? null,
    has: (id) => entries.some((e) => e.id === id),
    list: () => entries.map((e) => e.id),
  };
}
