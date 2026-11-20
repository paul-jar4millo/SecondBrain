import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CreateThread,
  FlowTemplate,
  ITEM_KINDS,
  Item,
  RequestAnswer,
  StreamMessage,
  THREAD_COMMAND_TYPES,
  THREAD_EVENT_TYPES,
  THREAD_STATUSES,
  Thread,
  ThreadCommand,
  ThreadEvent,
  ThreadId,
  ThreadStatus,
  formatSse,
  jsonSchemas,
  newId,
  resumePosition,
} from "../src/index.ts";
import { THREAD_ID, events, items, thread } from "./fixtures.ts";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("every item kind round-trips through JSON", () => {
  for (const kind of ITEM_KINDS) {
    const item = items[kind];
    assert.deepEqual(Item.parse(roundTrip(item)), item, kind);
  }
});

test("item kinds, event types and command types are exhaustive", () => {
  const kinds = Item.options.map((o) => o.shape.kind.value).sort();
  assert.deepEqual(kinds, [...ITEM_KINDS].sort());
  const types = ThreadEvent.options.map((o) => o.shape.type.value).sort();
  assert.deepEqual(types, [...THREAD_EVENT_TYPES].sort());
  assert.deepEqual(events.map((e) => e.type).sort(), types);
  const commands = ThreadCommand.options.map((o) => o.shape.type.value);
  assert.deepEqual(commands.sort(), [...THREAD_COMMAND_TYPES].sort());
  assert.deepEqual(ThreadStatus.options, [...THREAD_STATUSES]);
});

test("every event round-trips through JSON", () => {
  for (const event of events)
    assert.deepEqual(ThreadEvent.parse(roundTrip(event)), event, event.type);
});

test("every command type parses", () => {
  const samples = [
    {
      type: "CreateThread",
      prompt: "do it",
      kind: "scratch",
      agent: { engine: "claude" },
    },
    { type: "SendMessage", threadId: THREAD_ID, text: "x", mode: "queue" },
    { type: "Interrupt", threadId: THREAD_ID },
    {
      type: "AnswerRequest",
      threadId: THREAD_ID,
      requestId: "req_abcdef123456",
      answer: { approved: true },
      origin: "app",
    },
    { type: "CloseThread", threadId: THREAD_ID, mode: "merge" },
    { type: "Archive", threadId: THREAD_ID },
    {
      type: "ApproveSubtask",
      threadId: THREAD_ID,
      requestId: "req_abcdef123456",
      approved: false,
    },
  ];
  assert.deepEqual(
    samples.map((s) => ThreadCommand.parse(s).type),
    [...THREAD_COMMAND_TYPES],
  );
  const created = CreateThread.parse(samples[0]);
  assert.equal(created.autonomy, "auto-worktree");
  assert.deepEqual(created.attachments, []);
});

test("rejects inconsistent values", () => {
  assert.equal(ThreadId.safeParse("thr_x").success, false);
  assert.equal(ThreadId.safeParse(newId("thread")).success, true);
  assert.equal(
    Thread.safeParse({ ...thread, kind: "scratch" }).success,
    false,
    "scratch thread with a repo",
  );
  assert.equal(
    Thread.safeParse({ ...thread, repo: { ...thread.repo, branch: "main" } })
      .success,
    false,
    "branch outside sb/",
  );
  assert.equal(
    CreateThread.safeParse({
      type: "CreateThread",
      prompt: "x",
      kind: "repo",
      agent: { engine: "codex" },
    }).success,
    false,
    "repo thread without repoPath",
  );
  assert.equal(RequestAnswer.safeParse({}).success, false);
  assert.equal(
    FlowTemplate.safeParse({
      id: "x",
      name: "X",
      description: "",
      stages: [{ key: "a", name: "A", role: "plan", readOnly: true }],
      handoffs: [{ from: "a", to: "b" }],
      maxReviewRounds: 3,
    }).success,
    false,
    "hand-off to an unknown stage",
  );
  assert.equal(
    Item.safeParse({ ...items.notice, kind: "mystery" }).success,
    false,
  );
});

test("stream messages and SSE helpers", () => {
  const delta = {
    type: "item.delta",
    threadId: THREAD_ID,
    itemId: items.assistant_message.id,
    field: "text",
    delta: "ho",
    afterSeq: 4,
  };
  assert.deepEqual(StreamMessage.parse(delta), delta);
  assert.equal(formatSse({ a: 1 }, 7), 'id: 7\ndata: {"a":1}\n\n');
  assert.equal(
    formatSse({ type: "heartbeat" }),
    'data: {"type":"heartbeat"}\n\n',
  );
  assert.equal(resumePosition("12", "3"), 12);
  assert.equal(resumePosition(undefined, "3"), 3);
  assert.equal(resumePosition("x", null), 0);
  assert.equal(resumePosition("-1", "2.5"), 0);
});

test("exports JSON Schema for the public contracts", () => {
  const schemas = jsonSchemas();
  for (const [name, schema] of Object.entries(schemas))
    assert.equal(typeof schema, "object", name);
  const item = schemas.Item as { oneOf?: unknown[]; anyOf?: unknown[] };
  assert.equal((item.oneOf ?? item.anyOf)?.length, ITEM_KINDS.length);
});
