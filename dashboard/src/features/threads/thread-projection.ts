import { useSyncExternalStore } from "react";
import { isDemo } from "../../core/store";
import { onLongHidden } from "../../core/visibility";
import { threadsApi } from "./thread-api";
import { followFeed } from "./thread-stream";
import type { Thread } from "./thread-types";

let snapshot: { threads: Thread[]; loaded: boolean; error: string } = {
  threads: [],
  loaded: false,
  error: "",
};
const listeners = new Set<() => void>();
let stopFeed: (() => void) | undefined;
let pending: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let refreshAgain = false;
let stopWatching: (() => void) | undefined;

function scheduleRefresh() {
  timer ??= setTimeout(() => {
    timer = undefined;
    void threadProjection.refresh();
  }, 500);
}

export const threadProjection = {
  getSnapshot: () => snapshot,
  refresh(): Promise<void> {
    if (isDemo || !listeners.size) return Promise.resolve();
    if (pending) {
      refreshAgain = true;
      return pending;
    }
    pending = threadsApi
      .list()
      .then(({ threads, globalSeq }) => {
        snapshot = { threads, loaded: true, error: "" };
        if (listeners.size && !stopFeed && globalSeq !== undefined)
          stopFeed = followFeed(
            globalSeq,
            (event) => {
              if (!event.type.startsWith("item.")) scheduleRefresh();
            },
            scheduleRefresh,
          );
      })
      .catch((error: Error) => {
        snapshot = { ...snapshot, loaded: true, error: error.message };
      })
      .finally(() => {
        pending = undefined;
        for (const listener of listeners) listener();
        if (refreshAgain && listeners.size) scheduleRefresh();
        refreshAgain = false;
      });
    return pending;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    if (!isDemo && listeners.size === 1) {
      void threadProjection.refresh();
      poll = setInterval(() => {
        if (!document.hidden) void threadProjection.refresh();
      }, 20_000);
      // A background tab gives its feed back; refresh() reopens it.
      stopWatching = onLongHidden(
        () => {
          stopFeed?.();
          stopFeed = undefined;
        },
        () => void threadProjection.refresh(),
      );
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      stopFeed?.();
      stopFeed = undefined;
      clearTimeout(timer);
      timer = undefined;
      clearInterval(poll);
      stopWatching?.();
      stopWatching = undefined;
    };
  },
};

export function useThreadProjection() {
  return useSyncExternalStore(
    threadProjection.subscribe,
    threadProjection.getSnapshot,
  );
}
