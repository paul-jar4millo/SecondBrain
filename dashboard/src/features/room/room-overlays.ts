// One stack for every panel that sits over the refuge (agent, board, help, team desk).
// Escape closes the top one, focus goes back to what opened it, and openers keep
// aria-expanded in sync. Entries sharing a `slot` replace each other.

type Focusable =
  { focus?: () => void; isConnected?: boolean } | null | undefined;

export interface OverlayOptions {
  slot?: string;
  close: () => void;
  returnFocus?: () => Focusable;
  fallbackFocus?: () => Focusable;
  controls?: () => (
    { setAttribute(name: string, value: string): void } | null | undefined
  )[];
}

type OverlayEntry = OverlayOptions & { id: string };

export function createOverlayStack({
  onChange = () => {},
}: { onChange?: (list: string[]) => void } = {}) {
  let entries: OverlayEntry[] = [];
  const expand = (entry: OverlayEntry, value: boolean) => {
    for (const el of entry.controls?.() || [])
      el?.setAttribute("aria-expanded", String(value));
  };
  const notify = () => onChange(entries.map((e) => e.id));
  const focusBack = (entry: OverlayEntry) => {
    const target = entry.returnFocus?.();
    if (target?.isConnected !== false && target?.focus) target.focus();
    else entry.fallbackFocus?.()?.focus?.();
  };
  function remove(id: string, { restoreFocus }: { restoreFocus: boolean }) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return false;
    entries = entries.filter((e) => e !== entry);
    entry.close();
    expand(entry, false);
    if (restoreFocus) focusBack(entry);
    return true;
  }
  const stack = {
    open(id: string, options: OverlayOptions) {
      const previous = entries.find((e) => e.id === id);
      if (previous) entries = entries.filter((e) => e !== previous);
      const rival =
        options.slot && entries.find((e) => e.slot === options.slot);
      if (rival) remove(rival.id, { restoreFocus: false });
      const entry: OverlayEntry = { ...previous, ...options, id };
      entries.push(entry);
      expand(entry, true);
      notify();
    },
    /** Closes a specific overlay (its own close button). */
    close(id: string, { restoreFocus = true } = {}): boolean {
      const done = remove(id, { restoreFocus });
      if (done) notify();
      return done;
    },
    /** Escape: closes the overlay on top. Returns false when nothing was open. */
    closeTop() {
      const top = entries.at(-1);
      return top ? stack.close(top.id) : false;
    },
    /** Forget an overlay that already hid itself, without calling its close. */
    forget(id: string) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      entries = entries.filter((e) => e !== entry);
      expand(entry, false);
      notify();
    },
    top: () => entries.at(-1)?.id ?? null,
    has: (id: string) => entries.some((e) => e.id === id),
    list: () => entries.map((e) => e.id),
  };
  return stack;
}
