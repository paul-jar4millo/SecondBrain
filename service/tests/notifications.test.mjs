import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNotifications, notificationFor } from "../notifications.mjs";

const AT = "2026-11-21T10:00:00.000Z";
const THREAD = "thr_abc1234567";

test("only what needs the owner becomes a notification", () => {
  const info = { title: "Slug", stages: ["Planificar", "Implementar"] };
  assert.deepEqual(
    notificationFor(
      {
        type: "request.opened",
        request: { kind: "question", title: "¿Rama?" },
      },
      info,
    ),
    { kind: "request", text: "Te pregunta: ¿Rama?" },
  );
  assert.deepEqual(
    notificationFor(
      { type: "thread.updated", patch: { status: "ready-for-review" } },
      info,
    ),
    { kind: "ready-for-review", text: "Listo para revisar" },
  );
  assert.deepEqual(
    notificationFor(
      { type: "item.completed", item: { kind: "handoff", toStage: 1 } },
      info,
    ),
    { kind: "handoff", text: "Pasó a «Implementar»" },
  );
  assert.equal(
    notificationFor(
      { type: "thread.updated", patch: { status: "running" } },
      info,
    ),
    null,
  );
  assert.equal(
    notificationFor(
      { type: "item.completed", item: { kind: "assistant_message" } },
      info,
    ),
    null,
  );
});

test("the outbox keeps its cursor, counts unread and survives a restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-notifications-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "notifications.json");
  let lookups = 0;
  const threadInfo = async () => {
    lookups++;
    return { title: "Slug", stages: [] };
  };
  const outbox = await createNotifications({ file, threadInfo });
  const heard = /** @type {any[]} */ ([]);
  outbox.onNotify((n) => heard.push(n));
  await outbox.handle({
    type: "turn.started",
    threadId: THREAD,
    globalSeq: 3,
    at: AT,
  });
  const first = await outbox.handle({
    type: "request.opened",
    threadId: THREAD,
    globalSeq: 4,
    at: AT,
    request: { kind: "subtask", title: "Sub-tarea: Docs" },
  });
  assert.equal(first?.title, "Slug");
  assert.equal(first?.text, "Pide aprobar: Sub-tarea: Docs");
  // A replayed event is ignored.
  assert.equal(
    await outbox.handle({
      type: "request.opened",
      threadId: THREAD,
      globalSeq: 4,
      at: AT,
      request: { kind: "question", title: "otra" },
    }),
    null,
  );
  await outbox.handle({
    type: "thread.updated",
    threadId: THREAD,
    globalSeq: 7,
    at: AT,
    patch: { status: "failed" },
  });
  assert.equal(outbox.cursor(), 7);
  assert.equal(lookups, 1);
  assert.equal(heard.length, 2);
  assert.equal(outbox.list().unread, 2);
  assert.deepEqual(await outbox.markSeen(1), { unread: 1 });
  // Never past the last notification.
  assert.deepEqual(await outbox.markSeen(99), { unread: 0 });
  await outbox.flush();

  const again = await createNotifications({ file, threadInfo });
  assert.equal(again.cursor(), 7);
  assert.deepEqual(
    again.list().notifications.map((n) => n.kind),
    ["failed", "request"],
  );
  assert.equal(again.list().unread, 0);
});
