import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NewThreadEvent, ThreadEvent } from "../../contracts/src/index.ts";
import {
  AT,
  REQUEST_ID,
  THREAD_ID,
  TURN_ID,
  events as fixtureEvents,
  items,
  request,
  thread,
} from "../../contracts/tests/fixtures.ts";
import { openStore, type Store } from "../threads/store/event-log.ts";
import { migrate, SCHEMA_VERSION } from "../threads/store/migrations.ts";
import { PROJECTION_TABLES } from "../threads/store/projections.ts";
import { openDb } from "../threads/store/db.ts";

const strip = (event: ThreadEvent): NewThreadEvent => {
  const { seq: _seq, globalSeq: _globalSeq, ...rest } = event;
  return rest as NewThreadEvent;
};
const drafts = fixtureEvents.map(strip);

async function tempStore(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-store-"));
  const file = path.join(dir, "threads.sqlite");
  const store = openStore(file);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file, store };
}

function dump(store: Store) {
  return Object.fromEntries(
    PROJECTION_TABLES.map((table) => [
      table,
      store.db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => {
          const { id: _id, ...rest } = row as Record<string, unknown>;
          return JSON.stringify(table === "usage_snapshots" ? rest : row);
        })
        .sort(),
    ]),
  );
}

const otherThread = "thr_zzzzzz999999";
const createOther = (): NewThreadEvent => ({
  type: "thread.created",
  threadId: otherThread,
  at: AT,
  thread: {
    ...thread,
    id: otherThread,
    kind: "scratch",
    repo: null,
    workspace: "/srv/ws/x",
    flow: null,
  },
});

test("assigns gapless seq per thread and unique global seq", async (t) => {
  const { store } = await tempStore(t);
  const first = store.append(THREAD_ID, drafts.slice(0, 3));
  store.append(otherThread, [createOther()]);
  const rest = store.append(THREAD_ID, drafts.slice(3));
  const seqs = [...first, ...rest].map((e) => e.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i + 1),
  );
  const globals = store.readGlobalAfter(0).map((e) => e.globalSeq);
  assert.deepEqual(
    globals,
    globals.map((_, i) => i + 1),
  );
  assert.equal(store.lastSeq(THREAD_ID), drafts.length);
  assert.equal(store.lastSeq(otherThread), 1);
  assert.equal(store.lastGlobalSeq(), drafts.length + 1);
  assert.deepEqual(
    store.readAfter(THREAD_ID, 7).map((e) => e.type),
    ["request.resolved", "turn.completed"],
  );
  assert.equal(store.readAfter(THREAD_ID, 0, 2).length, 2);
  assert.deepEqual(
    store.readGlobalAfter(3, 1).map((e) => e.threadId),
    [otherThread],
  );
});

test("rejects bad appends atomically", async (t) => {
  const { store } = await tempStore(t);
  assert.throws(
    () => store.append(THREAD_ID, [drafts[1] as NewThreadEvent]),
    /must be thread.created/,
  );
  store.append(THREAD_ID, [drafts[0] as NewThreadEvent]);
  assert.throws(
    () => store.append(THREAD_ID, [drafts[0] as NewThreadEvent]),
    /already exists/,
  );
  // The second event is invalid: the first must not stay either.
  assert.throws(() =>
    store.append(THREAD_ID, [
      drafts[1] as NewThreadEvent,
      { ...(drafts[2] as NewThreadEvent), turnId: "bad" } as NewThreadEvent,
    ]),
  );
  assert.equal(store.lastSeq(THREAD_ID), 1);
  assert.throws(
    () => store.append(THREAD_ID, [createOther()]),
    /share its thread/,
  );
  assert.deepEqual(store.append(THREAD_ID, []), []);
});

test("projects threads, items, turns, requests and the inbox", async (t) => {
  const { store } = await tempStore(t);
  store.append(THREAD_ID, drafts);
  const snap = store.snapshot(THREAD_ID);
  assert.ok(snap);
  assert.equal(snap.thread.status, "running");
  assert.equal(snap.thread.lastSeq, drafts.length);
  assert.equal(snap.lastSeq, drafts.length);
  assert.equal(snap.thread.counters.turns, 1);
  assert.deepEqual(
    snap.items.map((i) => i.kind),
    ["assistant_message", "plan", "command"],
  );
  assert.equal(snap.requests[0]?.status, "answered");
  assert.equal(snap.requests[0]?.origin, "discord");
  assert.deepEqual(store.turns(THREAD_ID)[0], {
    id: TURN_ID,
    threadId: THREAD_ID,
    stageIndex: 0,
    outcome: "interrupted",
    startedSeq: 3,
    completedSeq: 9,
  });
  assert.equal(store.getItem(items.plan.id)?.kind, "plan");
  assert.equal(store.getItem("itm_missing00"), null);
  assert.equal(store.getRequest(REQUEST_ID)?.status, "answered");
  assert.equal(store.snapshot("thr_missing000"), null);
  assert.equal(
    (
      store.db.prepare("SELECT COUNT(*) AS n FROM stages").get() as {
        n: number;
      }
    ).n,
    1,
  );

  // Inbox: an open request plus a thread that needs a decision.
  store.append(otherThread, [
    createOther(),
    {
      type: "request.opened",
      threadId: otherThread,
      at: AT,
      request: { ...request, id: "req_other00001", threadId: otherThread },
    },
  ]);
  store.append(THREAD_ID, [
    {
      type: "thread.updated",
      threadId: THREAD_ID,
      at: "2026-11-20T19:00:00.000Z",
      patch: { status: "needs-decision" },
    },
  ]);
  assert.deepEqual(
    store.inbox().map((e) => [e.threadId, e.reason, e.requestId]),
    [
      [otherThread, "request", "req_other00001"],
      [THREAD_ID, "needs-decision", null],
    ],
  );
  assert.deepEqual(
    store.listThreads({ statuses: ["needs-decision"] }).map((x) => x.id),
    [THREAD_ID],
  );
  assert.deepEqual(
    store.listThreads({ parentId: null }).map((x) => x.id),
    [THREAD_ID, otherThread],
  );
  store.append(otherThread, [
    {
      type: "thread.updated",
      threadId: otherThread,
      at: AT,
      patch: { status: "archived" },
    },
  ]);
  assert.deepEqual(
    store.listThreads().map((x) => x.id),
    [THREAD_ID],
  );
  assert.equal(store.listThreads({ includeArchived: true }).length, 2);
  assert.deepEqual(
    store.inbox().map((e) => e.threadId),
    [THREAD_ID],
    "archived threads leave the inbox",
  );
});

test("replaying the log rebuilds identical projections", async (t) => {
  const { store } = await tempStore(t);
  store.append(THREAD_ID, drafts);
  store.append(otherThread, [createOther()]);
  store.append(THREAD_ID, [
    {
      type: "item.completed",
      threadId: THREAD_ID,
      at: AT,
      item: { ...items.handoff, seq: 10 },
    },
    {
      type: "item.completed",
      threadId: THREAD_ID,
      at: AT,
      item: { ...items.review, seq: 11 },
    },
    {
      type: "item.completed",
      threadId: THREAD_ID,
      at: AT,
      item: { ...items.usage, seq: 12 },
    },
  ]);
  store.recordUsage({
    engine: "codex",
    at: AT,
    source: "status-line",
    windows: [{ window: "weekly", usedPercent: 10, resetsAt: null }],
  });
  const before = dump(store);
  assert.equal(before.handoffs?.length, 1);
  assert.equal(before.reviews?.length, 1);
  assert.equal(before.usage_snapshots?.length, 2);
  store.rebuildProjections();
  assert.deepEqual(dump(store), before);
  assert.equal(store.latestUsage("codex")?.source, "status-line");
  assert.equal(store.latestUsage("claude")?.windows[0]?.usedPercent, 42);
  assert.equal(store.latestUsage("agy"), null);
});

test("migrations are idempotent and refuse newer schemas", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "threads.sqlite");
  const store = openStore(file);
  store.append(THREAD_ID, drafts.slice(0, 1));
  assert.equal(migrate(store.db), SCHEMA_VERSION);
  store.close();
  const again = openStore(file);
  assert.equal(again.lastSeq(THREAD_ID), 1);
  again.close();
  const db = openDb(file);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrate(db), /newer than this launcher/);
  db.close();
  const memory = openDb(":memory:");
  assert.equal(migrate(memory), SCHEMA_VERSION);
  memory.close();
  // Backups are consistent copies that open as stores.
  const fresh = openStore(path.join(dir, "fresh.sqlite"));
  fresh.append(THREAD_ID, drafts);
  fresh.backup(path.join(dir, "backup", "copy.sqlite"));
  fresh.close();
  const copy = openStore(path.join(dir, "backup", "copy.sqlite"));
  assert.equal(copy.lastSeq(THREAD_ID), drafts.length);
  copy.close();
});

test("notifies subscribers after commit and survives broken ones", async (t) => {
  const { store } = await tempStore(t);
  const seen: number[] = [];
  store.subscribe(() => {
    throw new Error("broken");
  });
  const off = store.subscribe((events) =>
    seen.push(...events.map((e) => e.seq)),
  );
  store.append(THREAD_ID, drafts.slice(0, 2));
  off();
  store.append(THREAD_ID, drafts.slice(2, 3));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(store.lastSeq(THREAD_ID), 3);
});
