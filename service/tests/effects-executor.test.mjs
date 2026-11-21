import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createApplication } from "../index.mjs";
import { createEffectsExecutor } from "../effects-executor.mjs";
import { createUserRequestStore } from "../user-requests.mjs";
import { getCsrfHeaders } from "./helpers/csrf.mjs";

test("flujo preparar -> aprobar -> ejecutar -> recibo, idempotencia y conciliación ante timeout", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-flow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Efectos Sintéticos\n");

  let externalCalls = 0;
  let forceTimeoutOnce = false;

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    effects: {
      externalRunner: async (payload) => {
        externalCalls++;
        if (forceTimeoutOnce) {
          forceTimeoutOnce = false;
          throw Object.assign(new Error("Timeout enviando mensaje externo"), {
            ambiguous: true,
          });
        }
        return { messageId: "ext-" + payload.requestId };
      },
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const appHeaders = await getCsrfHeaders(base);
  const agentHeaders = {
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": "ambar",
  };

  // 1) Prepare protected message send -> creates linked approval (no secrets leaked)
  const prepRes = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      category: "external_message",
      action: "send_email",
      recipient: "contacto-sintetico@localhost.invalid",
      content: "Postulación sintética revisada",
      cost: 0,
      scope: "allow_once",
      toolProfileId: "coordinacion",
    }),
  });
  assert.equal(prepRes.status, 201);
  const { operacion: operation, solicitud: request } = await prepRes.json();
  assert.equal(operation.status, "preparada");
  assert.equal(operation.approvalId, request.id);
  assert.equal(externalCalls, 0);

  // 2) User approves via CSRF-authenticated endpoint
  const approveRes = await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: request.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });
  assert.equal(approveRes.status, 200);

  // 3) Agent executes through service executor -> gets receipt, never raw secret
  const execReqId = randomUUID();
  const exec1 = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ id: operation.id, requestId: execReqId }),
  });
  assert.equal(exec1.status, 200);
  const body1 = await exec1.json();
  assert.equal(body1.repetido, false);
  assert.equal(body1.recibo.status, "confirmada");
  assert.equal(externalCalls, 1);

  // Idempotent retry returns same receipt WITHOUT re-running externalRunner
  const execRetry = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ id: operation.id, requestId: execReqId }),
  });
  assert.equal(execRetry.status, 200);
  const retryBody = await execRetry.json();
  assert.equal(retryBody.repetido, true);
  assert.equal(retryBody.recibo.requestId, execReqId);
  assert.equal(externalCalls, 1);

  // 4) Ambiguous timeout marks "entrega_incierta", blocks blind retries, requires explicit reconciliation
  const prep2 = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      category: "job_application",
      action: "submit_application",
      recipient: "empresa-demo@localhost.invalid",
      content: "CV sintético v1",
      cost: 0,
      scope: "allow_once",
    }),
  }).then((r) => r.json());

  await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: prep2.solicitud.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });

  forceTimeoutOnce = true;
  const timedOut = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      id: prep2.operacion.id,
      requestId: randomUUID(),
    }),
  });
  assert.equal(timedOut.status, 504);
  assert.equal(app.effects.get(prep2.operacion.id).status, "entrega_incierta");
  assert.equal(externalCalls, 2);

  // Blind retry with new requestId MUST be rejected without calling externalRunner again
  const blockedRetry = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      id: prep2.operacion.id,
      requestId: randomUUID(),
    }),
  });
  assert.equal(blockedRetry.status, 409);
  assert.equal(externalCalls, 2);

  // Agent cannot reconcile -> user reconciles explicitly
  const agentReconcile = await fetch(`${base}/effects/reconcile`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      id: prep2.operacion.id,
      requestId: randomUUID(),
      outcome: "confirmada",
    }),
  });
  assert.equal(agentReconcile.status, 403);

  const userReconcile = await fetch(`${base}/effects/reconcile`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: prep2.operacion.id,
      requestId: randomUUID(),
      outcome: "confirmada",
      note: "Confirmado manualmente en bandeja de salida",
    }),
  });
  assert.equal(userReconcile.status, 200);
  assert.equal(app.effects.get(prep2.operacion.id).status, "ejecutada");
});

test("ensayos obligatorios de bypass de efectos y gasto bloquean ejecución sin aprobación, mutaciones, vencimientos, turnos ajenos y gasto no autorizado", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-bypass-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Bypass de efectos\n");

  let externalCalls = 0;
  let now = 1_700_000_000_000;
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    userRequests: { clock: () => now },
    effects: {
      clock: () => now,
      externalRunner: async () => {
        externalCalls++;
        return { sent: true };
      },
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const appHeaders = await getCsrfHeaders(base);
  const agentHeaders = (ag = "lira") => ({
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": ag,
  });

  // Bypass 1: Unprepared direct execution attempt -> 404/403, zero calls
  const noPrep = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ id: randomUUID(), requestId: randomUUID() }),
  });
  assert.ok([403, 404, 409].includes(noPrep.status));

  // Prepare normal external message
  const prep = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      category: "external_message",
      action: "send_whatsapp",
      recipient: "destinatario-1",
      content: "Hola original",
      cost: 0,
      scope: "allow_once",
      nativeTurnId: "turn-alpha",
    }),
  }).then((r) => r.json());

  // Bypass 2: Agent attempts to execute BEFORE user approves -> 409
  const execUnapproved = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({ id: prep.operacion.id, requestId: randomUUID() }),
  });
  assert.equal(execUnapproved.status, 409);

  // Bypass 3: Agent attempts to approve its own request with room token -> 403
  const selfApprove = await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      id: prep.solicitud.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });
  assert.equal(selfApprove.status, 403);

  // User approves
  await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: prep.solicitud.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });

  // Bypass 4: Execute targeting wrong native turn -> 409
  const wrongTurn = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      id: prep.operacion.id,
      requestId: randomUUID(),
      expectedNativeTurnId: "turn-beta-otro",
    }),
  });
  assert.equal(wrongTurn.status, 409);

  // Bypass 5: Mutating recipient/cost/content after user approved -> invalidates approval -> cancelada (409)
  const tampered = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      id: prep.operacion.id,
      requestId: randomUUID(),
      recipient: "atacante-externo",
    }),
  });
  assert.equal(tampered.status, 409);
  assert.equal(app.effects.get(prep.operacion.id).status, "cancelada");

  // Bypass 6: Expired approval cannot execute -> vencida (409)
  const expPrep = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      category: "external_message",
      action: "send_email",
      recipient: "dest-exp",
      content: "Hola",
      ttlMs: 1000,
    }),
  }).then((r) => r.json());
  await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: expPrep.solicitud.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });
  now += 5000;
  const expiredExec = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders("ambar"),
    body: JSON.stringify({
      id: expPrep.operacion.id,
      requestId: randomUUID(),
    }),
  });
  assert.equal(expiredExec.status, 409);
  assert.equal(app.effects.get(expPrep.operacion.id).status, "vencida");

  // Bypass 7: Unapproved billed API / spending route (spending policy) -> blocked 403 with free/subscription hint
  const billedBlocked = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders("marina"),
    body: JSON.stringify({
      category: "financial_spend",
      action: "activate_billed_api_deepseek",
      recipient: "deepseek-api",
      cost: 15,
    }),
  });
  assert.equal(billedBlocked.status, 403);
  const billedErr = await billedBlocked.json();
  assert.match(billedErr.error, /gasto/);
  assert.match(billedErr.error, /suscripci/i);

  assert.equal(externalCalls, 0);
});

test("regresión P1: prohíbe reutilizar aprobación con requestId repetido y distinta operación o huella persistida", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-repro-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const runnerCalls = [];
  const reqStore = await createUserRequestStore(path.join(dir, "solicitudes"));
  const executor = await createEffectsExecutor(path.join(dir, "efectos"), {
    userRequests: reqStore,
    externalRunner: async (payload) => {
      runnerCalls.push(payload.recipient);
      return { delivered: true };
    },
  });

  const sharedReqId = randomUUID();
  const prepA = await executor.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "a@localhost.invalid",
    content: "Mensaje aprobado para A",
    requestId: sharedReqId,
  });

  // Same requestId + same operation is strictly idempotent
  const prepAReplay = await executor.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "a@localhost.invalid",
    content: "Mensaje aprobado para A",
    requestId: sharedReqId,
  });
  assert.equal(prepAReplay.repetido, true);
  assert.equal(prepAReplay.operacion.id, prepA.operacion.id);

  await reqStore.respond(prepA.solicitud.id, {
    requestId: randomUUID(),
    approve: true,
    by: "owner",
    origin: "pc",
  });

  // Reusing same requestId for a different recipient B MUST fail 409 and NEVER reuse A's approval
  await assert.rejects(
    executor.prepareEffect({
      category: "external_message",
      action: "send_email",
      recipient: "b@localhost.invalid",
      content: "Mensaje distinto para B",
      requestId: sharedReqId,
    }),
    { status: 409 },
  );

  // Even if persisted state were mismatched on disk, executeEffect compares persisted fields against linked approval
  await executor.close();
  await reqStore.cerrar();
  await appendFile(
    path.join(dir, "efectos", "efectos-journal.jsonl"),
    `${JSON.stringify({
      op: "effect.put",
      effect: {
        ...prepA.operacion,
        id: randomUUID(),
        prepareRequestId: randomUUID(),
        recipient: "b@localhost.invalid",
        operationFingerprint: "0".repeat(64),
      },
    })}\n`,
  );
  const reqStore2 = await createUserRequestStore(path.join(dir, "solicitudes"));
  const executor2 = await createEffectsExecutor(path.join(dir, "efectos"), {
    userRequests: reqStore2,
    externalRunner: async (payload) => {
      runnerCalls.push(payload.recipient);
      return { delivered: true };
    },
  });
  const forged = executor2
    .list()
    .find((e) => e.recipient === "b@localhost.invalid");
  assert.ok(forged);
  // Client omits recipient/changes -> persisted check MUST still block with 409!
  await assert.rejects(
    executor2.executeEffect(forged.id, { requestId: randomUUID() }),
    { status: 409 },
  );
  assert.deepEqual(runnerCalls, []);

  // Original operation A still executes cleanly once
  const okA = await executor2.executeEffect(prepA.operacion.id, {
    requestId: randomUUID(),
  });
  assert.equal(okA.recibo.recipient, "a@localhost.invalid");
  assert.deepEqual(runnerCalls, ["a@localhost.invalid"]);

  await executor2.close();
  await reqStore2.cerrar();
});

test("regresión P1: efecto en «ejecutando» tras caída entre runner y recibo recupera como entrega_incierta durable sin reenviar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let runnerCalls = 0;
  let stallRunner;
  const reqStore1 = await createUserRequestStore(path.join(dir, "solicitudes"));
  const exec1 = await createEffectsExecutor(path.join(dir, "efectos"), {
    userRequests: reqStore1,
    externalRunner: async () => {
      runnerCalls++;
      // Simulate process dying right after external send, before saving receipt
      await new Promise((resolve) => {
        stallRunner = resolve;
      });
      return { delivered: true };
    },
  });

  const prep = await exec1.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "destino@localhost.invalid",
    content: "Único envío permitido",
    requestId: randomUUID(),
  });
  await reqStore1.respond(prep.solicitud.id, {
    requestId: randomUUID(),
    approve: true,
    by: "owner",
  });

  const execReqId1 = randomUUID();
  const inFlightPromise = exec1.executeEffect(prep.operacion.id, {
    requestId: execReqId1,
  });
  // Wait until runner incremented and effect "ejecutando" is flushed to disk
  while (runnerCalls === 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runnerCalls, 1);

  // Reopen store after simulated crash -> MUST recover "ejecutando" -> "entrega_incierta" durably
  const reqStore2 = await createUserRequestStore(path.join(dir, "solicitudes"));
  const exec2 = await createEffectsExecutor(path.join(dir, "efectos"), {
    userRequests: reqStore2,
    externalRunner: async () => {
      runnerCalls++;
      return { delivered: true };
    },
  });
  assert.equal(exec2.get(prep.operacion.id).status, "entrega_incierta");
  assert.equal(reqStore2.get(prep.solicitud.id).status, "entrega_incierta");

  // Reopen a SECOND time -> state remains durably "entrega_incierta" across restarts
  await exec2.close();
  await reqStore2.cerrar();
  const reqStore3 = await createUserRequestStore(path.join(dir, "solicitudes"));
  const exec3 = await createEffectsExecutor(path.join(dir, "efectos"), {
    userRequests: reqStore3,
    externalRunner: async () => {
      runnerCalls++;
      return { delivered: true };
    },
  });
  assert.equal(exec3.get(prep.operacion.id).status, "entrega_incierta");

  // Retry with SAME UUID OR NEW UUID MUST fail 409 without invoking runner again
  await assert.rejects(
    exec3.executeEffect(prep.operacion.id, { requestId: execReqId1 }),
    { status: 409 },
  );
  await assert.rejects(
    exec3.executeEffect(prep.operacion.id, { requestId: randomUUID() }),
    { status: 409 },
  );
  assert.equal(runnerCalls, 1);

  // Only explicit reconciliation closes it and keeps runnerCalls === 1
  const reconciled = await exec3.reconcileEffect(prep.operacion.id, {
    requestId: randomUUID(),
    outcome: "confirmada",
    note: "Verificado enviado en proveedor",
  });
  assert.equal(reconciled.operacion.status, "ejecutada");
  assert.equal(reconciled.recibo.status, "confirmada");
  await assert.rejects(
    exec3.executeEffect(prep.operacion.id, { requestId: randomUUID() }),
    { status: 409 },
  );
  const replayConfirmed = await exec3.executeEffect(prep.operacion.id, {
    requestId: execReqId1,
  });
  assert.equal(replayConfirmed.repetido, true);
  assert.equal(runnerCalls, 1);

  stallRunner();
  await inFlightPromise.catch(() => {});
  await exec3.close();
  await reqStore3.cerrar();
  await exec1.close();
  await reqStore1.cerrar();
});

test("regresión: sin conector configurado nunca simula éxito sintético y conserva aprobación sin consumir", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-noconn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sin conector\n");

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const appHeaders = await getCsrfHeaders(base);
  const agentHeaders = {
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": "ambar",
  };

  const prep = await fetch(`${base}/effects/prepare`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      category: "external_message",
      action: "send_email",
      recipient: "manual@localhost.invalid",
      content: "Contenido para envío manual",
    }),
  }).then((r) => r.json());
  assert.equal(prep.operacion.connectorAvailable, false);
  assert.equal(prep.operacion.executionMode, "manual_sin_conector");

  await fetch(`${base}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: prep.solicitud.id,
      requestId: randomUUID(),
      approve: true,
    }),
  });

  const execRes = await fetch(`${base}/effects/execute`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      id: prep.operacion.id,
      requestId: randomUUID(),
    }),
  });
  assert.equal(execRes.status, 503);
  const errBody = await execRes.json();
  assert.match(errBody.error, /conector|manual/i);
  assert.equal(app.effects.get(prep.operacion.id).status, "preparada");
  assert.equal(app.effects.get(prep.operacion.id).executionReceipt, null);
  assert.equal(app.userRequests.get(prep.solicitud.id).status, "confirmada");
});

test("regresión P1 journal efectos: repara cola truncada en arranque antes de escribir nuevos registros y rechaza corrupción intermedia", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-effects-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const reqDir = path.join(dir, "solicitudes");
  const effDir = path.join(dir, "efectos");
  const reqStore1 = await createUserRequestStore(reqDir);
  const effStore1 = await createEffectsExecutor(effDir, {
    userRequests: reqStore1,
    externalRunner: async () => ({ sent: true }),
  });

  const eff1 = await effStore1.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "u1@localhost.invalid",
    content: "Primero",
    requestId: randomUUID(),
  });
  await reqStore1.respond(eff1.solicitud.id, {
    requestId: randomUUID(),
    approve: true,
  });
  const rec1 = await effStore1.executeEffect(eff1.operacion.id, {
    requestId: randomUUID(),
  });
  await effStore1.close();
  await reqStore1.cerrar();

  // Simulate half-written tail without trailing newline
  await appendFile(path.join(effDir, "efectos-journal.jsonl"), '{"op":');

  const reqStore2 = await createUserRequestStore(reqDir);
  const effStore2 = await createEffectsExecutor(effDir, {
    userRequests: reqStore2,
    externalRunner: async () => ({ sent: true }),
  });
  const eff2 = await effStore2.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "u2@localhost.invalid",
    content: "Segundo",
    requestId: randomUUID(),
  });
  const eff3 = await effStore2.prepareEffect({
    category: "external_message",
    action: "send_email",
    recipient: "u3@localhost.invalid",
    content: "Tercero",
    requestId: randomUUID(),
  });
  await effStore2.close();
  await reqStore2.cerrar();

  // Second restart MUST succeed without SyntaxError and retain all IDs/receipts
  const reqStore3 = await createUserRequestStore(reqDir);
  const effStore3 = await createEffectsExecutor(effDir, {
    userRequests: reqStore3,
    externalRunner: async () => ({ sent: true }),
  });
  assert.equal(
    effStore3.get(eff1.operacion.id).executionReceipt.requestId,
    rec1.recibo.requestId,
  );
  assert.equal(
    effStore3.get(eff2.operacion.id).recipient,
    "u2@localhost.invalid",
  );
  assert.equal(
    effStore3.get(eff3.operacion.id).recipient,
    "u3@localhost.invalid",
  );
  await effStore3.close();
  await reqStore3.cerrar();

  // Authentic middle corruption MUST still fail explicitly
  const badDir = path.join(dir, "bad-efectos");
  await mkdir(badDir, { recursive: true });
  const existingLines = (
    await readFile(path.join(effDir, "efectos-journal.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  await writeFile(
    path.join(badDir, "efectos-journal.jsonl"),
    `${existingLines[0]}\n{"op":\n${existingLines[existingLines.length - 1]}\n`,
  );
  const reqBad = await createUserRequestStore(path.join(dir, "bad-req"));
  await assert.rejects(
    createEffectsExecutor(badDir, { userRequests: reqBad }),
    SyntaxError,
  );
  await reqBad.cerrar();
});
