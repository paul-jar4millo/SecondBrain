import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import { test } from "node:test";

import { createClaudeController } from "../provider-controllers.mjs";

import {
  createHarness,
  isPidAlive,
  waitFor,
} from "./helpers/provider-fakes.mjs";

test("contrato 1: Codex, ACP y Claude mantienen un único PID en múltiples turnos + interrupción y liberan al cerrar/eliminar", async (t) => {
  let claudeQueryCalls = 0;
  let claudeInterruptCalls = 0;
  let claudeClosed = false;

  const h = await createHarness(t, {
    claudeControllerFactory: () =>
      createClaudeController(({ prompt }) => {
        claudeQueryCalls += 1;
        let closed = false;
        let waitInterrupt = null;
        let pushOut = null;
        const outQueue = [];
        const emit = (msg) => {
          if (pushOut) {
            const res = pushOut;
            pushOut = null;
            res({ value: msg, done: false });
          } else {
            outQueue.push(msg);
          }
        };
        void (async () => {
          let turnNum = 0;
          for await (const userMsg of prompt) {
            if (closed) break;
            turnNum += 1;
            const text = userMsg.message.content;
            if (turnNum === 1) {
              emit({ type: "system", subtype: "init", session_id: "cl-pid-1" });
            }
            if (text.includes("ESPERAR_INTERRUMPIR")) {
              emit({
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "claude trabajando" }],
                },
              });
              await new Promise((resolve) => {
                waitInterrupt = resolve;
              });
              emit({
                type: "result",
                subtype: "error_during_execution",
                is_interrupt: true,
                session_id: "cl-pid-1",
              });
            } else {
              emit({
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "text",
                      text: `claude-ok q=${claudeQueryCalls} turn=${turnNum}`,
                    },
                  ],
                },
              });
              emit({
                type: "result",
                subtype: "success",
                result: `claude-ok q=${claudeQueryCalls} turn=${turnNum}`,
                session_id: "cl-pid-1",
              });
            }
          }
          if (pushOut) {
            const res = pushOut;
            pushOut = null;
            res({ value: undefined, done: true });
          }
        })();
        return {
          async interrupt() {
            claudeInterruptCalls += 1;
            waitInterrupt?.();
            waitInterrupt = null;
          },
          close() {
            closed = true;
            claudeClosed = true;
            waitInterrupt?.();
          },
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (outQueue.length > 0) {
                  return Promise.resolve({
                    value: outQueue.shift(),
                    done: false,
                  });
                }
                if (closed)
                  return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                  pushOut = resolve;
                });
              },
              return() {
                closed = true;
                claudeClosed = true;
                waitInterrupt?.();
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      }),
  });

  // --- CODEX: 4 turns + interrupt in 1 OS PID ---
  const codexSess = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "codex-turno-uno",
    structured: true,
  });
  await h.ejecutor.esperar(codexSess.id);
  const afterT1 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT1.estado, "terminada");
  assert.equal(afterT1.conexion.estado, "ociosa");
  const codexPid1 = afterT1.conexion.pid;
  assert.ok(isPidAlive(codexPid1));
  assert.equal(h.ejecutor.activos(), 1);

  await h.ejecutor.continuar(codexSess.id, "codex-turno-dos");
  await h.ejecutor.esperar(codexSess.id);
  const afterT2 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT2.conexion.pid, codexPid1);
  assert.match(
    afterT2.resultado,
    new RegExp(`pid=${codexPid1} turno=2 .* prev=codex-turno-uno`),
  );

  await h.ejecutor.continuar(codexSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(codexSess.id)
      .then((s) => s.items.some((i) => i.texto?.includes("Trabajando pid="))),
  );
  await h.ejecutor.cancelar(codexSess.id);
  await h.ejecutor.esperar(codexSess.id);
  const afterT3 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT3.estado, "cancelada");
  assert.equal(afterT3.conexion.estado, "ociosa");
  assert.equal(afterT3.conexion.pid, codexPid1);
  assert.ok(isPidAlive(codexPid1));

  await h.ejecutor.continuar(codexSess.id, "codex-turno-cuatro");
  await h.ejecutor.esperar(codexSess.id);
  const afterT4 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT4.estado, "terminada");
  assert.match(afterT4.resultado, new RegExp(`pid=${codexPid1} turno=4`));
  assert.equal(
    h.spawnedBinsAndArgs.filter((x) => x.motor === "codex").length,
    1,
  );

  await h.ejecutor.cerrarConexion(codexSess.id, "Prueba cierre explícito");
  await waitFor(() => !isPidAlive(codexPid1));
  assert.equal(h.ejecutor.activos(), 0);
  await h.ejecutor.eliminar(codexSess.id);

  // --- ACP (agy): 4 turns + interrupt in 1 OS PID ---
  const acpSess = await h.ejecutor.encargar({
    motor: "agy",
    origen: "sala",
    proyecto: "demo",
    brief: "acp-turno-uno",
    modelo: "gemini-3.8-flash-medium",
    structured: true,
  });
  await h.ejecutor.esperar(acpSess.id);
  const acp1 = h.registro.leer().find((s) => s.id === acpSess.id);
  const acpPid1 = acp1.conexion.pid;
  assert.ok(isPidAlive(acpPid1));
  assert.equal(acp1.conexion.estado, "ociosa");

  await h.ejecutor.continuar(acpSess.id, "acp-turno-dos");
  await h.ejecutor.esperar(acpSess.id);
  const acp2 = h.registro.leer().find((s) => s.id === acpSess.id);
  assert.match(
    acp2.resultado,
    new RegExp(`acp pid=${acpPid1} turno=2 .* prev=acp-turno-uno`),
  );

  await h.ejecutor.continuar(acpSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(acpSess.id)
      .then((s) =>
        s.items.some((i) => i.texto?.includes("acp-esperando pid=")),
      ),
  );
  await h.ejecutor.cancelar(acpSess.id);
  await h.ejecutor.esperar(acpSess.id);
  assert.ok(isPidAlive(acpPid1));

  await h.ejecutor.continuar(acpSess.id, "acp-turno-cuatro");
  await h.ejecutor.esperar(acpSess.id);
  assert.match(
    h.registro.leer().find((s) => s.id === acpSess.id).resultado,
    new RegExp(`acp pid=${acpPid1} turno=4`),
  );
  assert.equal(h.spawnedBinsAndArgs.filter((x) => x.motor === "agy").length, 1);

  await h.ejecutor.eliminar(acpSess.id);
  await waitFor(() => !isPidAlive(acpPid1));
  assert.equal(h.ejecutor.activos(), 0);

  // --- CLAUDE SDK: 3 turns + interrupt reusing 1 streaming query ---
  const claudeSess = await h.ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    brief: "cl-1",
    structured: true,
  });
  await h.ejecutor.esperar(claudeSess.id);
  await h.ejecutor.continuar(claudeSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(claudeSess.id)
      .then((s) => s.items.some((i) => i.texto?.includes("claude trabajando"))),
  );
  await h.ejecutor.cancelar(claudeSess.id);
  await h.ejecutor.esperar(claudeSess.id);
  await h.ejecutor.continuar(claudeSess.id, "cl-3");
  await h.ejecutor.esperar(claudeSess.id);
  const cl3 = h.registro.leer().find((s) => s.id === claudeSess.id);
  assert.equal(cl3.resultado, "claude-ok q=1 turn=3");
  assert.equal(claudeQueryCalls, 1);
  assert.equal(claudeInterruptCalls, 1);
  await h.ejecutor.eliminar(claudeSess.id);
  assert.equal(claudeClosed, true);
  assert.equal(h.ejecutor.activos(), 0);
});

test("contrato 2: maxActivos cuenta procesos vivos ociosos, evicta con estado visible y reanuda sesión evictada; bloquea si ocupada", async (t) => {
  const h = await createHarness(t, { maxActivos: 1 });

  const s1 = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "primera",
    structured: true,
  });
  await h.ejecutor.esperar(s1.id);
  const s1Done = h.registro.leer().find((s) => s.id === s1.id);
  const pid1 = s1Done.conexion.pid;
  assert.equal(s1Done.estado, "terminada");
  assert.equal(h.ejecutor.activos(), 1);
  assert.ok(isPidAlive(pid1));

  // Starting s2 while s1 is idle MUST evict s1 cleanly without exceeding maxActivos=1
  const s2 = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "ESPERAR_INTERRUMPIR",
    structured: true,
  });
  await waitFor(() => !isPidAlive(pid1));
  const s1Evicted = h.registro.leer().find((s) => s.id === s1.id);
  assert.equal(s1Evicted.conexion.estado, "evictada");
  assert.match(s1Evicted.conexion.motivo, /límite/i);
  const s1Snap = await h.conversations.snapshot(s1.id);
  assert.equal(s1Snap.connection.status, "evicted");
  assert.equal(h.ejecutor.activos(), 1);

  // Wait until s2 is busy mid-turn; starting s3 MUST throw Límite de sesiones activas
  await waitFor(() =>
    h.conversations
      .snapshot(s2.id)
      .then((s) => s.items.some((i) => i.texto?.includes("Trabajando pid="))),
  );
  await assert.rejects(
    () =>
      h.ejecutor.encargar({
        motor: "codex",
        origen: "sala",
        proyecto: "demo",
        brief: "tercera-bloqueada",
        structured: true,
      }),
    /Límite de sesiones activas/,
  );

  // Stop s2 cleanly and resume evicted s1 via thread/resume
  await h.ejecutor.cancelar(s2.id);
  await h.ejecutor.esperar(s2.id);
  const s2Pid = h.registro.leer().find((s) => s.id === s2.id).conexion.pid;
  await h.ejecutor.continuar(s1.id, "reanudar-evictada");
  await h.ejecutor.esperar(s1.id);
  await waitFor(() => !isPidAlive(s2Pid));
  const s1Resumed = h.registro.leer().find((s) => s.id === s1.id);
  assert.equal(s1Resumed.estado, "terminada");
  assert.notEqual(s1Resumed.conexion.pid, pid1);
  assert.match(s1Resumed.resultado, /reanudar-evictada|turno=1/);
  assert.equal(
    h.registro.leer().find((s) => s.id === s2.id).conexion.estado,
    "evictada",
  );

  // Auto-eviction on idle timeout
  const idleHarness = await createHarness(t, {
    maxActivos: 2,
    idleControllerMs: 50,
  });
  const si = await idleHarness.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "auto-evict",
    structured: true,
  });
  await idleHarness.ejecutor.esperar(si.id);
  const siPid = idleHarness.registro.leer().find((s) => s.id === si.id)
    .conexion.pid;
  assert.ok(isPidAlive(siPid));
  await waitFor(
    () =>
      !isPidAlive(siPid) &&
      idleHarness.ejecutor.activos() === 0 &&
      idleHarness.registro.leer().find((s) => s.id === si.id)?.conexion
        ?.estado === "evictada",
  );
  const siAfter = idleHarness.registro.leer().find((s) => s.id === si.id);
  assert.equal(siAfter.conexion.estado, "evictada");
  assert.match(siAfter.conexion.motivo, /inactividad/i);
});

test("contrato 3: reconexión reutilizando mismo JSON-RPC id invalida callback previo sin contaminar ni responder el nuevo", async (t) => {
  const h = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "reuse-id-disconnect" },
  });

  const s = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "turno-caida",
    structured: true,
  });

  const oldReq = await waitFor(async () => {
    const snap = await h.conversations.snapshot(s.id);
    return snap.requests.find((r) => r.status === "pending");
  });
  await h.ejecutor.esperar(s.id);

  // Turn 1 crashed mid-callback: product preserves question as pendiente, nativeCallbackStatus interrupted
  const afterCrash = await h.conversations.snapshot(s.id);
  const keptOld = afterCrash.requests.find((r) => r.id === oldReq.id);
  assert.equal(keptOld.productStatus, "pendiente");
  assert.equal(keptOld.nativeCallbackStatus, "interrupted");

  // Reconnect Turn 2 which ALSO sends JSON-RPC id=77
  await h.ejecutor.continuar(s.id, "turno-reconectado");
  const newReq = await waitFor(async () => {
    const snap = await h.conversations.snapshot(s.id);
    return snap.requests.find(
      (r) => r.id !== oldReq.id && r.nativeCallbackStatus === "open",
    );
  });

  // Attempting to answer oldReq.id MUST fail 409 without touching newReq's callback
  await assert.rejects(
    () =>
      h.conversations.answer(s.id, {
        requestId: oldReq.id,
        responseId: randomUUID(),
        answers: { q1: "Si" },
      }),
    (err) => err.status === 409,
  );

  // Now answering newReq resolves Turn 2 cleanly
  const receipt = await h.conversations.answer(s.id, {
    requestId: newReq.id,
    responseId: randomUUID(),
    answers: { q2: "Si" },
  });
  assert.equal(receipt.delivered, true);
  await h.ejecutor.esperar(s.id);
  const done = h.registro.leer().find((x) => x.id === s.id);
  assert.equal(done.estado, "terminada");
  assert.match(done.resultado, /answered-77=/);
});
