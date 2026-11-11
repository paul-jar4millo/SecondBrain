const listeners = new Set<() => void>();
let source: EventSource | undefined;
export function subscribeChanges(listener: () => void): () => void {
  if (
    typeof EventSource === "undefined" ||
    import.meta.env.VITE_DEMO === "1" ||
    new URLSearchParams(location.search).has("demo") ||
    sessionStorage.getItem("sb-demo") === "true"
  )
    return () => {};
  listeners.add(listener);
  if (!source) {
    source = new EventSource("/api/v1/events");
    source.onmessage = source.onopen = () => {
      for (const fn of listeners) fn();
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      source?.close();
      source = undefined;
    }
  };
}
