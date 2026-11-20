import assert from "node:assert/strict";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test } from "node:test";

import { createClaudeController } from "../provider-controllers.mjs";
import { createProviderConversations } from "../provider-conversations.mjs";
import { openSessionRegistry } from "../sessions.mjs";

import { createHarness, waitFor } from "./helpers/provider-fakes.mjs";

test("contrato 4: error de escritura guarda respuesta y marca entrega_incierta (nunca delivered); progreso promueve a confirmada y doble respuesta no duplica", async (t) => {
  // Subcase A: delayed progress shows entregada -> confirmada ONLY on subsequent harness progress, and concurrent double answer
  const hProgress = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "delayed-progress" },
  });
  const sp = await hProgress.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "progreso",
    structured: true,
  });
  const reqP = await waitFor(async () => {
    const snap = await hProgress.conversations.snapshot(sp.id);
    return snap.requests.find((r) => r.status === "pending");
  });

  const r1 = randomUUID();
  const r2 = randomUUID();
  const [a1, a2] = await Promise.allSettled([
    hProgress.conversations.answer(sp.id, {
      requestId: reqP.id,
      responseId: r1,
      answers: { q1: "Si" },
    }),
    hProgress.conversations.answer(sp.id, {
      requestId: reqP.id,
      responseId: r2,
      answers: { q1: "No" },
    }),
  ]);
  const fulfilled = [a1, a2].filter((x) => x.status === "fulfilled");
  const rejected = [a1, a2].filter((x) => x.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.status, "entregada");
  assert.equal(fulfilled[0].value.delivered, true);

  // Immediately after RPC write flush (before fake CLI emits progress after 120ms), NOT yet confirmada!
  const beforeProgress = await hProgress.conversations.snapshot(sp.id);
  const reqBefore = beforeProgress.requests.find((r) => r.id === reqP.id);
  assert.equal(reqBefore.productStatus, "entregada");

  // Idempotent retry on same responseId returns stored receipt
  const retryReceipt = await hProgress.conversations.answer(sp.id, {
    requestId: reqP.id,
    responseId: fulfilled[0].value.responseId,
    answers: { q1: "Si" },
  });
  assert.equal(retryReceipt.responseId, fulfilled[0].value.responseId);
  assert.equal(retryReceipt.status, "entregada");

  await hProgress.ejecutor.esperar(sp.id);
  const afterProgress = await hProgress.conversations.snapshot(sp.id);
  const reqAfter = afterProgress.requests.find((r) => r.id === reqP.id);
  assert.equal(reqAfter.productStatus, "confirmada");
  assert.equal(afterProgress.receipts.length, 1);
  assert.ok(afterProgress.receipts[0].harnessConfirmedAt);

  // Subcase B: write failure preserves saved answer with entrega_incierta (delivered: false)
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-write-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessId = randomUUID();
  const reg = await openSessionRegistry(path.join(dir, "s.json"));
  await reg.crear({
    id: sessId,
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    encargo: "x",
    structured: true,
  });
  const conv = createProviderConversations({
    directory: path.join(dir, "conv"),
    registro: reg,
    adapters: {
      codex: async (ctx) => {
        await ctx.nativeId("t-fail");
        const writeAck = Promise.reject(new Error("EPIPE roto"));
        writeAck.catch(() => {});
        await ctx.ask(
          randomUUID(),
          {
            kind: "question",
            header: "P",
            prompt: "¿Continuar?",
            questions: [
              {
                id: "P",
                header: "P",
                prompt: "¿Continuar?",
                options: [{ id: "si", label: "Si" }],
              },
            ],
          },
          {
            writeAck,
          },
        );
      },
    },
  });
  let _askPromise;
  const runDone = conv.run({
    session: { id: sessId, motor: "codex", structured: true },
    prompt: "hola",
    cwd: dir,
    onNativeId: () => {},
  });
  const reqFail = await waitFor(async () => {
    const snap = await conv.snapshot(sessId);
    return snap.requests.find((r) => r.status === "pending");
  });
  const receiptFail = await conv.answer(sessId, {
    requestId: reqFail.id,
    responseId: randomUUID(),
    answers: { P: "Si" },
  });
  assert.equal(receiptFail.status, "entrega_incierta");
  assert.equal(receiptFail.delivered, false);
  const snapFail = await conv.snapshot(sessId);
  assert.deepEqual(snapFail.requests[0].answer.answers, { P: "Si" });
  assert.equal(snapFail.requests[0].productStatus, "entrega_incierta");
  await runDone.catch(() => {});
});

test("regresión: Claude reporta callback_returned sin fingir rpc_write_flushed; fallo preserva respuesta en entrega_incierta; interrupt() público funciona", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-cl-ack-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  let mode = "success_delayed_progress";
  let releaseTurn = null;
  let capturedInterruptCount = 0;

  const registro = await openSessionRegistry(path.join(dir, "ses.json"));
  const conv = createProviderConversations({
    directory: path.join(dir, "conv"),
    registro,
    adapters: {
      claude: {
        createController: () =>
          createClaudeController(({ prompt, options }) => ({
            async interrupt() {
              capturedInterruptCount += 1;
            },
            close() {},
            async *[Symbol.asyncIterator]() {
              const iter = prompt[Symbol.asyncIterator]();
              await iter.next();
              if (mode === "interrupt_only") {
                yield {
                  type: "system",
                  subtype: "init",
                  session_id: "cl-int-1",
                };
                await new Promise((r) => {
                  releaseTurn = r;
                });
                yield {
                  type: "result",
                  subtype: "error_during_execution",
                  is_interrupt: true,
                  session_id: "cl-int-1",
                };
                return;
              }
              await options.onElicitation({
                serverName: "synth",
                mode: "form",
                message: "Confirma",
                requestedSchema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                },
              });
              if (mode === "fail_before_progress") {
                // SDK fails right after receiving callback WITHOUT emitting assistant/result:success
                yield {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  session_id: "cl-fail-1",
                };
                return;
              }
              await new Promise((r) => {
                releaseTurn = r;
              });
              yield {
                type: "assistant",
                uuid: "a1",
                message: { content: [{ type: "text", text: "progreso real" }] },
                session_id: "cl-ok-1",
              };
              yield {
                type: "result",
                subtype: "success",
                result: "progreso real",
                session_id: "cl-ok-1",
              };
            },
          })),
      },
    },
  });

  // Subcase A: callback returns -> status is "entregando" / callback_returned (NOT rpc_write_flushed or delivered=true), then promotes on progress
  const s1 = await registro.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    encargo: "a",
    structured: true,
  });
  const run1 = conv.run({
    session: s1,
    prompt: "p",
    cwd: dir,
    mcpServers: {},
    env: {},
    operatorEnv: {},
    spawn: () => {},
    onNativeId: () => {},
  });
  const req1 = await waitFor(async () =>
    (await conv.snapshot(s1.id)).requests.find((r) => r.status === "pending"),
  );
  const ackRes = await conv.answer(s1.id, {
    requestId: req1.id,
    responseId: randomUUID(),
    decision: "accept",
    content: { ok: true },
  });
  assert.equal(ackRes.status, "entregando");
  assert.equal(ackRes.callbackReturned, true);
  assert.equal(ackRes.delivered, false);
  assert.equal(ackRes.transportObservable, false);
  assert.equal(ackRes.transportEvidence, "callback_returned");
  assert.match(ackRes.transportLimit, /SDK/);
  releaseTurn?.();
  await run1;
  const snap1 = await conv.snapshot(s1.id);
  assert.equal(snap1.receipts[0].status, "confirmada");
  assert.equal(snap1.receipts[0].delivered, true);
  assert.equal(snap1.receipts[0].transportEvidence, "harness_progress");

  // Subcase B: SDK receives callback then fails before emitting progress -> reconciles to entrega_incierta keeping answer
  mode = "fail_before_progress";
  const s2 = await registro.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    encargo: "b",
    structured: true,
  });
  const run2 = conv
    .run({
      session: s2,
      prompt: "p",
      cwd: dir,
      mcpServers: {},
      env: {},
      operatorEnv: {},
      spawn: () => {},
      onNativeId: () => {},
    })
    .catch(() => null);
  const req2 = await waitFor(async () =>
    (await conv.snapshot(s2.id)).requests.find((r) => r.status === "pending"),
  );
  await conv.answer(s2.id, {
    requestId: req2.id,
    responseId: randomUUID(),
    decision: "accept",
    content: { ok: false },
  });
  await run2;
  const snap2 = await conv.snapshot(s2.id);
  assert.equal(snap2.receipts[0].status, "entrega_incierta");
  assert.equal(snap2.receipts[0].delivered, false);
  assert.deepEqual(snap2.requests[0].answer.content, { ok: false });

  // Subcase C (regression): direct controller.interrupt() works without ReferenceError
  mode = "interrupt_only";
  const directCtrl = createClaudeController(({ prompt }) => ({
    async interrupt() {
      capturedInterruptCount += 1;
      releaseTurn?.();
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      for await (const _ of prompt) {
        yield { type: "system", subtype: "init", session_id: "cl-int-1" };
        await new Promise((r) => {
          releaseTurn = r;
        });
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_interrupt: true,
          session_id: "cl-int-1",
        };
        break;
      }
    },
  }));
  const intTurn = directCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "claude" },
    cwd: dir,
    prompt: "espera",
    mcpServers: {},
    env: {},
    operatorEnv: {},
    message: () => {},
    delta: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({}),
    spawn: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  directCtrl.interrupt();
  const intRes = await intTurn;
  assert.equal(intRes.status, "interrupted");
  assert.ok(capturedInterruptCount >= 1);
  await directCtrl.shutdown();
});
