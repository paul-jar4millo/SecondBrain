// Live streams (SSE) hold a connection each, and over HTTP/1.1 a browser
// allows six per host across all tabs. A tab left in the background for a
// while gives its streams back; they reconnect when it is shown again.
import { useEffect, useState } from "react";

const GRACE_MS = 15_000;

/**
 * Calls `onHide` once the page has been hidden for `graceMs`, and `onShow`
 * when it is shown again after that. Returns the unsubscribe function.
 */
export function onLongHidden(
  onHide: () => void,
  onShow: () => void,
  graceMs = GRACE_MS,
): () => void {
  if (typeof document === "undefined") return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hidden = false;
  const change = () => {
    if (document.hidden) {
      timer ??= setTimeout(() => {
        timer = undefined;
        hidden = true;
        onHide();
      }, graceMs);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    if (hidden) {
      hidden = false;
      onShow();
    }
  };
  document.addEventListener("visibilitychange", change);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", change);
  };
}

/** False while the page has been hidden for a while. */
export function usePageActive(graceMs = GRACE_MS) {
  const [active, setActive] = useState(true);
  useEffect(
    () =>
      onLongHidden(
        () => setActive(false),
        () => setActive(true),
        graceMs,
      ),
    [graceMs],
  );
  return active;
}
