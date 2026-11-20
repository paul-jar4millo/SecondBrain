// The live view of one thread: a snapshot plus the events and deltas of its
// stream. Pure functions, no network and no React.
import type {
  Item,
  StreamMessage,
  ThreadEvent,
  ThreadSnapshot,
  UserRequest,
  Thread,
} from "./thread-types";

export interface ThreadView {
  thread: Thread;
  /** Items in order of first appearance. */
  items: Item[];
  requests: UserRequest[];
  lastSeq: number;
  /** Turn running now, as far as the stream has told. */
  activeTurn: string | null;
}

export function fromSnapshot(snapshot: ThreadSnapshot): ThreadView {
  const running = snapshot.thread.status === "running";
  const last = [...snapshot.items].reverse().find((i) => i.turnId);
  return {
    thread: snapshot.thread,
    items: snapshot.items,
    requests: snapshot.requests,
    lastSeq: snapshot.lastSeq,
    activeTurn: running ? (last?.turnId ?? "pending") : null,
  };
}

const upsert = (items: Item[], item: Item): Item[] => {
  const index = items.findIndex((i) => i.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
};

export function applyEvent(view: ThreadView, event: ThreadEvent): ThreadView {
  if (event.threadId !== view.thread.id || event.seq <= view.lastSeq)
    return view;
  const next = { ...view, lastSeq: event.seq };
  switch (event.type) {
    case "thread.created":
      return { ...next, thread: event.thread };
    case "thread.updated":
      return {
        ...next,
        thread: { ...view.thread, ...event.patch } as Thread,
      };
    case "turn.started":
      return { ...next, activeTurn: event.turnId };
    case "turn.completed":
      return {
        ...next,
        activeTurn: view.activeTurn === event.turnId ? null : view.activeTurn,
      };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { ...next, items: upsert(view.items, event.item) };
    case "request.opened":
      return {
        ...next,
        requests: [
          ...view.requests.filter((r) => r.id !== event.request.id),
          event.request,
        ],
      };
    case "request.resolved":
      return {
        ...next,
        requests: view.requests.map((r) =>
          r.id === event.requestId
            ? {
                ...r,
                status: event.status,
                answer: event.answer,
                origin: event.origin,
                answeredAt: event.at,
              }
            : r,
        ),
      };
  }
  return next;
}

/** Applies one stream message; `null` means the view must be reloaded. */
export function applyMessage(
  view: ThreadView,
  message: StreamMessage,
): ThreadView | null {
  switch (message.type) {
    case "event":
      return applyEvent(view, message.event);
    case "item.snapshot":
      return { ...view, items: upsert(view.items, message.item) };
    case "item.delta": {
      const current = view.items.find((i) => i.id === message.itemId);
      if (!current) {
        if (message.field !== "text") return view;
        const at = new Date().toISOString();
        // First delta of a message the log has not seen yet.
        return {
          ...view,
          items: [
            ...view.items,
            {
              id: message.itemId,
              threadId: message.threadId,
              turnId: view.activeTurn === "pending" ? null : view.activeTurn,
              seq: message.afterSeq,
              status: "in-progress",
              agent: view.thread.agent,
              createdAt: at,
              updatedAt: at,
              kind: "assistant_message",
              text: message.delta,
            } as Item,
          ],
        };
      }
      if (message.field === "text" && "text" in current)
        return {
          ...view,
          items: upsert(view.items, {
            ...current,
            text: current.text + message.delta,
          } as Item),
        };
      if (message.field === "output" && current.kind === "command")
        return {
          ...view,
          items: upsert(view.items, {
            ...current,
            output: current.output + message.delta,
          }),
        };
      return view;
    }
    case "snapshot-required":
      return null;
    case "heartbeat":
      return view;
  }
}

export interface TurnGroup {
  turnId: string | null;
  /** The user's message that opened the turn, when there is one. */
  prompt: Item | null;
  /** Commands, edits, reasoning, tools… shown folded as "work". */
  work: Item[];
  /** What the agent said, shown in full. */
  messages: Item[];
  startedAt: string;
  endedAt: string;
  running: boolean;
}

const VISIBLE = new Set([
  "assistant_message",
  "user_request",
  "review",
  "handoff",
]);

/**
 * Groups items by turn for the timeline. Items outside a turn (user
 * messages, notices) become their own group.
 */
export function groupTurns(view: ThreadView): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const byTurn = new Map<string, TurnGroup>();
  for (const item of view.items) {
    if (item.kind === "usage") continue;
    const key = item.turnId;
    let group = key ? byTurn.get(key) : undefined;
    if (!group) {
      group = {
        turnId: key,
        prompt: null,
        work: [],
        messages: [],
        startedAt: item.createdAt,
        endedAt: item.updatedAt,
        running: false,
      };
      groups.push(group);
      if (key) byTurn.set(key, group);
    }
    if (item.updatedAt > group.endedAt) group.endedAt = item.updatedAt;
    if (item.kind === "user_message" && !key) group.prompt = item;
    else if (VISIBLE.has(item.kind) || item.kind === "user_message")
      group.messages.push(item);
    else group.work.push(item);
  }
  for (const group of groups)
    group.running =
      group.turnId !== null &&
      (group.turnId === view.activeTurn ||
        group.work.some((i) => i.status === "in-progress"));
  return groups;
}

/** "42 s", "3 min 5 s", "1 h 2 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const openRequests = (view: ThreadView) =>
  view.requests.filter((r) => r.status === "open");

export const STATUS_LABEL: Record<Thread["status"], string> = {
  "setting-up": "Preparando",
  idle: "En espera",
  running: "Trabajando",
  "waiting-user": "Espera tu respuesta",
  "in-review": "En revisión",
  "ready-for-review": "Listo para revisar",
  "needs-decision": "Necesita decisión",
  closing: "Cerrando",
  done: "Terminado",
  failed: "Falló",
  archived: "Archivado",
};

export const isWorkingThread = (thread: Thread) =>
  ["setting-up", "running", "in-review", "closing"].includes(thread.status);

export const isAttentionThread = (thread: Thread) =>
  ["waiting-user", "ready-for-review", "needs-decision", "failed"].includes(
    thread.status,
  );
