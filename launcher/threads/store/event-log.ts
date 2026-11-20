// Store API over threads.sqlite: an append-only event log (source of truth)
// plus projections updated in the same transaction (ADR 0009).
import {
  InboxEntry,
  ThreadEvent,
  UsageSnapshot,
  type Item,
  type NewThreadEvent,
  type Thread,
  type ThreadSnapshot,
  type ThreadStatus,
  type UserRequest,
} from "../../../contracts/src/index.ts";
import {
  backupTo,
  json,
  openDb,
  parseJson,
  transaction,
  type Db,
} from "./db.ts";
import { migrate } from "./migrations.ts";
import { applyEvent, clearProjections } from "./projections.ts";

export type AppendListener = (events: readonly ThreadEvent[]) => void;

export interface TurnRow {
  id: string;
  threadId: string;
  stageIndex: number;
  outcome: string | null;
  startedSeq: number;
  completedSeq: number | null;
}

export interface ThreadQuery {
  statuses?: readonly ThreadStatus[];
  parentId?: string | null;
  includeArchived?: boolean;
  limit?: number;
}

export interface Store {
  readonly db: Db;
  append(threadId: string, events: readonly NewThreadEvent[]): ThreadEvent[];
  subscribe(listener: AppendListener): () => void;
  readAfter(threadId: string, afterSeq: number, limit?: number): ThreadEvent[];
  readGlobalAfter(afterGlobalSeq: number, limit?: number): ThreadEvent[];
  lastSeq(threadId: string): number;
  lastGlobalSeq(): number;
  getThread(id: string): Thread | null;
  listThreads(query?: ThreadQuery): Thread[];
  items(threadId: string): Item[];
  getItem(id: string): Item | null;
  requests(threadId: string): UserRequest[];
  getRequest(id: string): UserRequest | null;
  turns(threadId: string): TurnRow[];
  snapshot(threadId: string): ThreadSnapshot | null;
  inbox(): InboxEntry[];
  recordUsage(snapshot: UsageSnapshot): void;
  latestUsage(engine: string): UsageSnapshot | null;
  rebuildProjections(): void;
  backup(file: string): void;
  close(): void;
}

const MAX_PAGE = 1000;

export function openStore(file: string): Store {
  const db = openDb(file);
  migrate(db);
  const listeners = new Set<AppendListener>();

  const one = <T>(sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).get(...params) as T | undefined;
  const all = <T>(sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).all(...params) as T[];
  const eventsFrom = (rows: { data: string }[]) =>
    rows.map((row) => parseJson<ThreadEvent>(row.data));
  const page = (limit: number) => Math.max(1, Math.min(limit, MAX_PAGE));

  const lastSeq = (threadId: string) =>
    one<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?",
      threadId,
    )?.seq ?? 0;
  const lastGlobalSeq = () =>
    one<{ seq: number | null }>("SELECT MAX(global_seq) AS seq FROM events")
      ?.seq ?? 0;

  const store: Store = {
    db,

    append(threadId, newEvents) {
      if (!newEvents.length) return [];
      const stored = transaction(db, () => {
        let seq = lastSeq(threadId);
        let globalSeq = lastGlobalSeq();
        const out: ThreadEvent[] = [];
        for (const draft of newEvents) {
          if (draft.threadId !== threadId)
            throw new Error("Every event of an append must share its thread.");
          if ((seq === 0) !== (draft.type === "thread.created"))
            throw new Error(
              seq === 0
                ? `The first event of ${threadId} must be thread.created.`
                : `Thread ${threadId} already exists.`,
            );
          const event = ThreadEvent.parse({
            ...draft,
            seq: ++seq,
            globalSeq: ++globalSeq,
          });
          db.prepare(
            `INSERT INTO events (thread_id, seq, global_seq, type, at, data)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            threadId,
            event.seq,
            event.globalSeq,
            event.type,
            event.at,
            json(event),
          );
          applyEvent(db, event);
          out.push(event);
        }
        return out;
      });
      for (const listener of listeners) {
        try {
          listener(stored);
        } catch {
          // A broken subscriber must not undo a committed append.
        }
      }
      return stored;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    readAfter(threadId, afterSeq, limit = MAX_PAGE) {
      return eventsFrom(
        all(
          `SELECT data FROM events WHERE thread_id = ? AND seq > ?
           ORDER BY seq LIMIT ?`,
          threadId,
          afterSeq,
          page(limit),
        ),
      );
    },

    readGlobalAfter(afterGlobalSeq, limit = MAX_PAGE) {
      return eventsFrom(
        all(
          "SELECT data FROM events WHERE global_seq > ? ORDER BY global_seq LIMIT ?",
          afterGlobalSeq,
          page(limit),
        ),
      );
    },

    lastSeq,
    lastGlobalSeq,

    getThread(id) {
      const row = one<{ data: string }>(
        "SELECT data FROM threads WHERE id = ?",
        id,
      );
      return row ? parseJson<Thread>(row.data) : null;
    },

    listThreads({
      statuses,
      parentId,
      includeArchived = false,
      limit = 200,
    } = {}) {
      const where: string[] = [];
      const params: (string | number | null)[] = [];
      if (statuses?.length) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      } else if (!includeArchived) where.push("status <> 'archived'");
      if (parentId !== undefined) {
        where.push(parentId === null ? "parent_id IS NULL" : "parent_id = ?");
        if (parentId !== null) params.push(parentId);
      }
      const sql = `SELECT data FROM threads ${
        where.length ? `WHERE ${where.join(" AND ")}` : ""
      } ORDER BY updated_at DESC LIMIT ?`;
      return all<{ data: string }>(sql, ...params, page(limit)).map((row) =>
        parseJson<Thread>(row.data),
      );
    },

    items(threadId) {
      return all<{ data: string }>(
        "SELECT data FROM items WHERE thread_id = ? ORDER BY seq, id",
        threadId,
      ).map((row) => parseJson<Item>(row.data));
    },

    getItem(id) {
      const row = one<{ data: string }>(
        "SELECT data FROM items WHERE id = ?",
        id,
      );
      return row ? parseJson<Item>(row.data) : null;
    },

    requests(threadId) {
      return all<{ data: string }>(
        "SELECT data FROM requests WHERE thread_id = ? ORDER BY created_at, id",
        threadId,
      ).map((row) => parseJson<UserRequest>(row.data));
    },

    getRequest(id) {
      const row = one<{ data: string }>(
        "SELECT data FROM requests WHERE id = ?",
        id,
      );
      return row ? parseJson<UserRequest>(row.data) : null;
    },

    turns(threadId) {
      return all<{
        id: string;
        thread_id: string;
        stage_index: number;
        outcome: string | null;
        started_seq: number;
        completed_seq: number | null;
      }>(
        "SELECT * FROM turns WHERE thread_id = ? ORDER BY started_seq",
        threadId,
      ).map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        stageIndex: row.stage_index,
        outcome: row.outcome,
        startedSeq: row.started_seq,
        completedSeq: row.completed_seq,
      }));
    },

    snapshot(threadId) {
      const thread = store.getThread(threadId);
      if (!thread) return null;
      return {
        thread,
        items: store.items(threadId),
        requests: store.requests(threadId),
        lastSeq: thread.lastSeq,
      };
    },

    inbox() {
      return all<Record<string, unknown>>(
        "SELECT * FROM inbox_view ORDER BY since",
      ).map((row) =>
        InboxEntry.parse({
          threadId: row.thread_id,
          threadTitle: row.thread_title,
          reason: row.reason,
          requestId: row.request_id ?? null,
          summary: row.summary,
          since: row.since,
        }),
      );
    },

    recordUsage(snapshot) {
      const valid = UsageSnapshot.parse(snapshot);
      db.prepare(
        "INSERT INTO usage_snapshots (engine, at, source, data) VALUES (?, ?, ?, ?)",
      ).run(valid.engine, valid.at, valid.source, json(valid.windows));
    },

    latestUsage(engine) {
      const row = one<{
        engine: string;
        at: string;
        source: string;
        data: string;
      }>(
        `SELECT engine, at, source, data FROM usage_snapshots
         WHERE engine = ? ORDER BY at DESC, id DESC LIMIT 1`,
        engine,
      );
      return row
        ? UsageSnapshot.parse({
            engine: row.engine,
            at: row.at,
            source: row.source,
            windows: parseJson(row.data),
          })
        : null;
    },

    rebuildProjections() {
      transaction(db, () => {
        // Usage written directly (status line, API) is not in the log; keep it.
        const direct = all<{
          engine: string;
          at: string;
          source: string;
          data: string;
        }>(
          "SELECT engine, at, source, data FROM usage_snapshots WHERE source <> 'provider-event' ORDER BY id",
        );
        clearProjections(db);
        for (const row of all<{ data: string }>(
          "SELECT data FROM events ORDER BY global_seq",
        ))
          applyEvent(db, parseJson<ThreadEvent>(row.data));
        for (const row of direct)
          db.prepare(
            "INSERT INTO usage_snapshots (engine, at, source, data) VALUES (?, ?, ?, ?)",
          ).run(row.engine, row.at, row.source, row.data);
      });
    },

    backup(file) {
      backupTo(db, file);
    },

    close() {
      listeners.clear();
      db.close();
    },
  };
  return store;
}
