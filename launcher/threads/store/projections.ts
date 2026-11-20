// Projections derived from the event log. applyEvent is the only writer of
// the projection tables, so replaying the log rebuilds them exactly.
import type {
  Item,
  Thread,
  ThreadEvent,
  UserRequest,
} from "../../../contracts/src/index.ts";
import { json, parseJson, type Db } from "./db.ts";

export const PROJECTION_TABLES = [
  "threads",
  "items",
  "turns",
  "requests",
  "stages",
  "handoffs",
  "reviews",
  "usage_snapshots",
] as const;

function readThread(db: Db, id: string): Thread {
  const row = db.prepare("SELECT data FROM threads WHERE id = ?").get(id) as
    { data: string } | undefined;
  if (!row) throw new Error(`Thread ${id} has no projection.`);
  return parseJson<Thread>(row.data);
}

function writeThread(db: Db, thread: Thread): void {
  db.prepare(
    `INSERT INTO threads (id, kind, status, parent_id, last_seq, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
       last_seq = excluded.last_seq, updated_at = excluded.updated_at,
       data = excluded.data`,
  ).run(
    thread.id,
    thread.kind,
    thread.status,
    thread.parentId,
    thread.lastSeq,
    thread.createdAt,
    thread.updatedAt,
    json(thread),
  );
}

function writeItem(db: Db, item: Item): void {
  db.prepare(
    `INSERT INTO items (id, thread_id, turn_id, kind, status, seq, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
       updated_at = excluded.updated_at, data = excluded.data`,
  ).run(
    item.id,
    item.threadId,
    item.turnId,
    item.kind,
    item.status,
    item.seq,
    item.updatedAt,
    json(item),
  );
  if (item.status !== "completed") return;
  if (item.kind === "handoff")
    db.prepare(
      `INSERT OR REPLACE INTO handoffs (id, thread_id, from_stage, to_stage, at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      item.handoffId,
      item.threadId,
      item.fromStage,
      item.toStage,
      item.updatedAt,
      json(item),
    );
  if (item.kind === "review")
    db.prepare(
      `INSERT OR REPLACE INTO reviews (id, thread_id, round, verdict, at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      item.reviewId,
      item.threadId,
      item.round,
      item.verdict,
      item.updatedAt,
      json(item),
    );
  if (item.kind === "usage" && item.agent && item.rateLimits.length)
    db.prepare(
      `INSERT INTO usage_snapshots (engine, at, source, data) VALUES (?, ?, 'provider-event', ?)`,
    ).run(item.agent.engine, item.updatedAt, json(item.rateLimits));
}

function writeRequest(db: Db, request: UserRequest): void {
  db.prepare(
    `INSERT INTO requests (id, thread_id, status, created_at, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
  ).run(
    request.id,
    request.threadId,
    request.status,
    request.createdAt,
    json(request),
  );
}

/** Updates every projection for one stored event (inside the append transaction). */
export function applyEvent(db: Db, event: ThreadEvent): void {
  if (event.type === "thread.created") {
    const thread = {
      ...event.thread,
      lastSeq: event.seq,
      updatedAt: event.at,
    };
    writeThread(db, thread);
    thread.flow?.stages.forEach((stage, idx) =>
      db
        .prepare("INSERT INTO stages (thread_id, idx, data) VALUES (?, ?, ?)")
        .run(thread.id, idx, json(stage)),
    );
    return;
  }
  const thread = readThread(db, event.threadId);
  const next: Thread = { ...thread, lastSeq: event.seq, updatedAt: event.at };
  switch (event.type) {
    case "thread.updated":
      Object.assign(next, event.patch);
      break;
    case "turn.started":
      db.prepare(
        `INSERT INTO turns (id, thread_id, stage_index, agent, started_seq, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        event.turnId,
        event.threadId,
        event.stageIndex,
        json(event.agent),
        event.seq,
        event.at,
      );
      next.counters = { ...next.counters, turns: next.counters.turns + 1 };
      break;
    case "turn.completed":
      db.prepare(
        `UPDATE turns SET outcome = ?, error = ?, completed_seq = ?, completed_at = ?
         WHERE id = ?`,
      ).run(
        event.outcome,
        event.error ?? null,
        event.seq,
        event.at,
        event.turnId,
      );
      break;
    case "item.started":
    case "item.updated":
    case "item.completed":
      writeItem(db, event.item);
      break;
    case "request.opened":
      writeRequest(db, event.request);
      break;
    case "request.resolved": {
      const row = db
        .prepare("SELECT data FROM requests WHERE id = ?")
        .get(event.requestId) as { data: string } | undefined;
      if (!row) throw new Error(`Request ${event.requestId} is unknown.`);
      writeRequest(db, {
        ...parseJson<UserRequest>(row.data),
        status: event.status,
        answer: event.answer,
        origin: event.origin,
        answeredAt: event.at,
      });
      break;
    }
  }
  writeThread(db, next);
}

/** Deletes every projection row (the log stays). */
export function clearProjections(db: Db): void {
  for (const table of PROJECTION_TABLES) db.exec(`DELETE FROM ${table}`);
}
