export function createChangeFeed() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {NodeJS.Timeout | null | undefined} */
  let timer;
  return {
    /** @param {() => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const listener of listeners) listener();
      }, 100);
      timer.unref();
    },
  };
}
