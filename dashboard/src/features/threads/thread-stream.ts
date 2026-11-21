// Follows a thread: snapshot first, then its SSE stream. EventSource resumes
// on its own with Last-Event-ID; "snapshot-required" reloads; when the
// stream keeps failing, the view falls back to polling the snapshot.
import { useEffect, useRef, useState } from "react";
import { usePageActive } from "../../core/visibility";
import { threadsApi } from "./thread-api";
import { applyMessage, fromSnapshot, type ThreadView } from "./thread-store";
import type { StreamMessage, ThreadEvent } from "./thread-types";

const POLL_MS = 5000;
const MAX_FAILURES = 3;

export interface ThreadFollow {
  view: ThreadView | null;
  error: string;
  /** "live" while the stream is open, "polling" in the fallback. */
  mode: "connecting" | "live" | "polling";
  reload: () => void;
}

export function useThread(id: string | undefined): ThreadFollow {
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ThreadFollow["mode"]>("connecting");
  const [generation, setGeneration] = useState(0);
  const viewRef = useRef<ThreadView | null>(null);
  viewRef.current = view;
  // A background tab closes the stream; showing it reloads and reconnects.
  const active = usePageActive();

  useEffect(() => {
    if (!id || !active) return;
    let alive = true;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    const load = async () => {
      try {
        const snapshot = await threadsApi.snapshot(id);
        if (!alive) return null;
        const next = fromSnapshot(snapshot);
        setView(next);
        setError("");
        return next;
      } catch (e) {
        if (alive) setError((e as Error).message);
        return null;
      }
    };
    const startPolling = () => {
      setMode("polling");
      poll ??= setInterval(() => void load(), POLL_MS);
    };
    const connect = (after: number) => {
      if (typeof EventSource === "undefined") return startPolling();
      source = new EventSource(
        `/api/v1/threads/stream?id=${encodeURIComponent(id)}&after=${after}`,
      );
      source.onopen = () => {
        failures = 0;
        setMode("live");
      };
      source.onmessage = (event) => {
        let message: StreamMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const current = viewRef.current;
        if (!current) return;
        const next = applyMessage(current, message);
        if (next) {
          viewRef.current = next;
          setView(next);
          return;
        }
        source?.close();
        void load().then((fresh) => fresh && alive && connect(fresh.lastSeq));
      };
      source.onerror = () => {
        if (++failures < MAX_FAILURES) return;
        source?.close();
        startPolling();
      };
    };
    setMode("connecting");
    void load().then((first) => first && alive && connect(first.lastSeq));
    return () => {
      alive = false;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [id, generation, active]);

  return {
    view,
    error,
    mode,
    reload: () => setGeneration((g) => g + 1),
  };
}

/**
 * Calls `onEvent` for every new event of every thread (global feed), from
 * `after` on. Used to keep the list and the inbox fresh.
 */
export function followFeed(
  after: number,
  onEvent: (e: ThreadEvent) => void,
  onError?: () => void,
) {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`/api/v1/threads/feed?after=${after}`);
  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "event") onEvent(message.event);
      if (message.type === "snapshot-required") onError?.();
    } catch {
      /* ignore malformed data */
    }
  };
  if (onError) source.onerror = onError;
  return () => source.close();
}
