import { onLongHidden } from "./visibility";

const listeners = new Set<() => void>();
let source: EventSource | undefined;
let stopWatching: (() => void) | undefined;

function open() {
  source = new EventSource("/api/v1/events");
  // Opening (or reopening after the tab was hidden) refreshes everyone.
  source.onmessage = source.onopen = () => {
    for (const fn of listeners) fn();
  };
}
export function subscribeChanges(listener: () => void): () => void {
  if (
    typeof EventSource === "undefined" ||
    import.meta.env.VITE_DEMO === "1" ||
    new URLSearchParams(location.search).has("demo") ||
    sessionStorage.getItem("sb-demo") === "true"
  )
    return () => {};
  listeners.add(listener);
  if (!source) open();
  stopWatching ??= onLongHidden(
    () => {
      source?.close();
      source = undefined;
    },
    () => {
      if (listeners.size && !source) open();
    },
  );
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      source?.close();
      source = undefined;
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}
