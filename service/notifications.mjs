// Notifications (phase C1): the launcher's global feed becomes a short
// outbox of what needs the owner. The app shows it as a badge; web push and
// Discord read the same outbox.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Notifications kept on disk; older ones drop off. */
const KEEP = 200;

/**
 * @typedef {{
 *   id: number,
 *   globalSeq: number,
 *   threadId: string,
 *   kind: "request" | "needs-decision" | "ready-for-review" | "failed" | "handoff",
 *   title: string,
 *   text: string,
 *   at: string,
 * }} Notification
 *
 * @typedef {{
 *   title: string,
 *   stages: string[],
 * }} ThreadInfo
 *
 * @typedef {{ type: string, threadId?: string, globalSeq?: number, at?: string, [key: string]: any }} FeedEvent
 */

const STATUS_TEXT = /** @type {const} */ ({
  "needs-decision": "Necesita tu decisión",
  "ready-for-review": "Listo para revisar",
  failed: "Falló",
});

/**
 * What an event means for the owner, or null when it needs nothing.
 * @param {FeedEvent} event
 * @param {ThreadInfo | null} info
 * @returns {Pick<Notification, "kind" | "text"> | null}
 */
export function notificationFor(event, info) {
  if (event.type === "request.opened") {
    const request = event.request ?? {};
    return {
      kind: "request",
      text:
        request.kind === "subtask"
          ? `Pide aprobar: ${request.title}`
          : `Te pregunta: ${request.title}`,
    };
  }
  if (event.type === "thread.updated") {
    const status = event.patch?.status;
    if (status in STATUS_TEXT)
      return {
        kind: /** @type {keyof typeof STATUS_TEXT} */ (status),
        text: STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (status)],
      };
    return null;
  }
  if (event.type === "item.completed" && event.item?.kind === "handoff") {
    const to = Number(event.item.toStage);
    const name = info?.stages[to];
    return {
      kind: "handoff",
      text: name ? `Pasó a «${name}»` : `Pasó a la etapa ${to + 1}`,
    };
  }
  return null;
}

/**
 * @param {{
 *   file: string,
 *   threadInfo: (threadId: string) => Promise<ThreadInfo | null>,
 *   now?: () => string,
 * }} options
 */
export async function createNotifications({
  file,
  threadInfo,
  now = () => new Date().toISOString(),
}) {
  /** @type {{ cursor: number, seen: number, nextId: number, items: Notification[] }} */
  let state = { cursor: 0, seen: 0, nextId: 1, items: [] };
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved && Array.isArray(saved.items)) state = { ...state, ...saved };
  } catch {
    // First run, or an unreadable file: start empty.
  }
  /** @type {Set<(n: Notification) => void>} */
  const listeners = new Set();
  /** @type {Map<string, ThreadInfo>} */
  const infos = new Map();
  let writing = Promise.resolve();

  const save = () => {
    const snapshot = JSON.stringify(state);
    writing = writing
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await writeFile(temp, snapshot, { mode: 0o600 });
        await rename(temp, file);
      })
      .catch(() => undefined);
    return writing;
  };

  /** @param {string} threadId */
  const info = async (threadId) => {
    const cached = infos.get(threadId);
    if (cached) return cached;
    const fresh = await threadInfo(threadId).catch(() => null);
    if (fresh) infos.set(threadId, fresh);
    return fresh;
  };

  return {
    /** Where the feed should resume. */
    cursor: () => state.cursor,

    /**
     * Sets where to follow the feed from: the launcher's current position on
     * the first run (history is not replayed), or again after the launcher
     * lost its log.
     * @param {number} globalSeq
     */
    async resumeFrom(globalSeq) {
      const seq = Math.floor(Number(globalSeq));
      state.cursor = Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
      await save();
    },

    /** @param {FeedEvent} event */
    async handle(event) {
      const seq = Number(event.globalSeq);
      if (!Number.isSafeInteger(seq) || seq <= state.cursor) return null;
      state.cursor = seq;
      const threadId = String(event.threadId ?? "");
      if (event.type === "thread.created" && event.thread)
        infos.set(threadId, {
          title: String(event.thread.title ?? ""),
          stages: (event.thread.flow?.stages ?? []).map(
            (/** @type {{ name: string }} */ s) => s.name,
          ),
        });
      if (event.type === "thread.updated" && event.patch?.title)
        infos.delete(threadId);
      const meaning = notificationFor(
        event,
        threadId ? await info(threadId) : null,
      );
      if (!meaning) {
        // Keep the cursor without writing on every event.
        if (seq % 50 === 0) await save();
        return null;
      }
      /** @type {Notification} */
      const notification = {
        id: state.nextId++,
        globalSeq: seq,
        threadId,
        title: (await info(threadId))?.title || "Thread",
        at: typeof event.at === "string" ? event.at : now(),
        ...meaning,
      };
      state.items = [...state.items, notification].slice(-KEEP);
      await save();
      for (const listener of listeners) {
        try {
          listener(notification);
        } catch {
          // A failing channel must not stop the others.
        }
      }
      return notification;
    },

    /** Newest first, with how many the owner has not seen. */
    list(limit = 50) {
      return {
        notifications: [...state.items].reverse().slice(0, limit),
        unread: state.items.filter((n) => n.id > state.seen).length,
      };
    },

    /** @param {number} upTo */
    async markSeen(upTo) {
      const last = state.items.at(-1)?.id ?? 0;
      const next = Math.min(Math.max(state.seen, Math.floor(upTo)), last);
      if (next !== state.seen) {
        state.seen = next;
        await save();
      }
      return { unread: state.items.filter((n) => n.id > state.seen).length };
    },

    /** @param {(n: Notification) => void} listener */
    onNotify(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    flush: () => writing,
  };
}
