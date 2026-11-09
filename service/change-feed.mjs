// @ts-check
export function createChangeFeed() {
  const listeners = new Set();
  let timer;
  return {
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
