// Unread notifications (phase C1): the service keeps an outbox of what needs
// the owner; the HUD shows how many are unread, and opening Threads marks
// them seen.
import { useEffect, useSyncExternalStore } from "react";
import { subscribeChanges } from "../../core/events";
import { api, isDemo } from "../../core/store";

export interface ThreadNotification {
  id: number;
  threadId: string;
  kind: string;
  title: string;
  text: string;
  at: string;
}

let state = { unread: 0, latest: 0 };
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

const publish = (next: typeof state) => {
  if (next.unread === state.unread && next.latest === state.latest) return;
  state = next;
  for (const listener of listeners) listener();
};

async function refresh() {
  try {
    const result = await api<{
      notifications: ThreadNotification[];
      unread: number;
    }>("/notifications");
    publish({
      unread: result.unread,
      latest: result.notifications[0]?.id ?? 0,
    });
  } catch {
    // Offline or signed out: keep the last count.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!isDemo && listeners.size === 1) {
    void refresh();
    // Every launcher event reaches the app as a change; read again, calmly.
    stop = subscribeChanges(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 1000);
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stop?.();
    stop = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
}

export function useUnreadNotifications() {
  return useSyncExternalStore(subscribe, () => state.unread);
}

/** While Threads is open, what arrives counts as seen. */
export function useMarkNotificationsSeen() {
  const latest = useSyncExternalStore(subscribe, () => state.latest);
  useEffect(() => {
    if (isDemo || !latest || state.unread === 0) return;
    void api<{ unread: number }>("/notifications/seen", {
      method: "POST",
      body: JSON.stringify({ upTo: latest }),
    })
      .then(({ unread }) => publish({ ...state, unread }))
      .catch(() => undefined);
  }, [latest]);
}
