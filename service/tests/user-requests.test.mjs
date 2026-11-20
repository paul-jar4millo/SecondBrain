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
import { createUserRequestStore } from "../user-requests.mjs";
import { getCsrfHeaders } from "./helpers/csrf.mjs";

test("pregunta persiste antes de emitir evento y sobrevive cierre de turno, interrupción y reinicio", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-req-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let now = 1_700_000_000_000;
  const eventsObserved = [];
  let storeRef;

  const store = await createUserRequestStore(dir, {
    clock: () => now,
    onEvent: async (workOrderId, ev) => {
      // Request MUST already be persisted in the store & reloadable BEFORE event emission
      const fromStore = storeRef.get(ev.correlationId);
      assert.ok(fromStore, "Solicitud debe persistirse antes de emitir evento");
      eventsObserved.push({ workOrderId, ev });
    },
  });
  storeRef = store;

  const woId = randomUUID();
  const { solicitud: request } = await store.createRequest({
    workOrderId: woId,
    sessionId: "sess-1",
    memberId: "coord-ambar",
    title: "Enfoque de despliegue",
    prompt: "¿Mantener compatibilidad con rutas heredadas?",
    options: ["Sí", "No"],
    nativeRequestId: "native-req-1",
    nativeTurnId: "turn-1",
  });
  assert.equal(request.status, "pendiente");
  assert.equal(request.nativeCallbackStatus, "open");
  assert.equal(eventsObserved.length, 1);
  assert.equal(eventsObserved[0].ev.type, "user_request.created");

  // Native turn ends & interrupts callback -> product question STAYS pendiente
  await store.markTurnClosed({
    sessionId: "sess-1",
    nativeTurnId: "turn-1",
    reason: "closed_by_turn",
  });
  const afterClose = store.get(request.id);
  assert.equal(afterClose.status, "pendiente");
  assert.equal(afterClose.nativeCallbackStatus, "closed_by_turn");
  assert.equal(afterClose.requiresNewTurn, true);

  // Restart process -> question STILL survives
  await store.cerrar();
  const restarted = await createUserRequestStore(dir, { clock: () => now });
  const afterRestart = restarted.get(request.id);
  assert.equal(afterRestart.status, "pendiente");
  assert.equal(afterRestart.requiresNewTurn, true);

  // Wrong expectedNativeTurnId is rejected (409)
  await assert.rejects(
    restarted.respond(request.id, {
      requestId: randomUUID(),
      option: "Sí",
      expectedNativeTurnId: "turn-old-999",
    }),
    { status: 409 },
  );

  // Valid user response saves durable receipt without reusing closed native callback
  const reqId = randomUUID();
  const answered = await restarted.respond(request.id, {
    requestId: reqId,
    option: "Sí",
    by: "owner",
    origin: "movil",
  });
  assert.equal(answered.repetido, false);
  assert.equal(answered.solicitud.status, "respuesta_recibida");
  assert.equal(answered.solicitud.nativeCallbackStatus, "closed_by_turn");
  assert.equal(answered.solicitud.requiresNewTurn, true);
  assert.equal(answered.recibo.origin, "movil");

  // Delivery tracking across states
  const delivering = await restarted.updateDeliveryState(request.id, {
    status: "entregando",
  });
  assert.equal(delivering.status, "entregando");
  const uncertain = await restarted.updateDeliveryState(request.id, {
    status: "entrega_incierta",
    note: "Nuevo turno interrumpido antes del ACK",
  });
  assert.equal(uncertain.status, "entrega_incierta");
  const confirmed = await restarted.updateDeliveryState(request.id, {
    status: "confirmada",
  });
  assert.equal(confirmed.status, "confirmada");

  await restarted.cerrar();
});

test("aprobaciones validan expiración, invalidan por cambio de parámetros y resuelven carreras PC+móvil", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-req-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let now = 1_700_000_000_000;
  const store = await createUserRequestStore(dir, {
    clock: () => now,
    approvalTimeoutMs: 60_000,
  });

  // 1) Expiry keeps record visible as "vencida" and rejects late approval & execution
  const { solicitud: expTarget } = await store.createRequest({
    kind: "approval",
    prompt: "¿Transferir presupuesto sintético?",
    action: "finance.transfer",
    recipient: "cuenta-demo",
    cost: 120,
    scope: "allow_once",
    contentHash: "hash-1",
    ttlMs: 5000,
  });
  now += 6000;
  await assert.rejects(
    store.respond(expTarget.id, { requestId: randomUUID(), approve: true }),
    { status: 409 },
  );
  assert.equal(store.get(expTarget.id).status, "vencida");
  assert.ok(
    store.list({ status: "vencida" }).some((x) => x.id === expTarget.id),
  );

  // 2) Ephemeral live-callback approval turns into "vencida" upon restart
  const { solicitud: liveApproval } = await store.createRequest({
    kind: "approval",
    prompt: "Permiso de callback efímero",
    action: "tool.exec",
    recipient: "local",
    scope: "allow_once",
    nativeRequestId: "live-cb-1",
    nativeTurnId: "turn-live",
  });
  assert.equal(liveApproval.nativeCallbackStatus, "open");
  await store.cerrar();
  const afterCrash = await createUserRequestStore(dir, { clock: () => now });
  assert.equal(afterCrash.get(liveApproval.id).status, "vencida");

  // 3) Parameter change before execution invalidates approval
  const { solicitud: sensitive } = await afterCrash.createRequest({
    kind: "approval",
    prompt: "Publicar reporte",
    action: "publish",
    recipient: "canal-interno",
    cost: 0,
    contentHash: "v1",
    changes: { lines: 10 },
    scope: "allow_once",
  });
  await afterCrash.respond(sensitive.id, {
    requestId: randomUUID(),
    approve: true,
    by: "owner",
    origin: "pc",
  });
  await assert.rejects(
    afterCrash.verifyApprovalBeforeExecute(sensitive.id, {
      recipient: "canal-externo-modificado",
    }),
    { status: 409 },
  );
  assert.equal(afterCrash.get(sensitive.id).status, "cancelada");

  // 4) Concurrent PC + mobile responses yield 1 receipt and 409 with winning receipt for loser
  const { solicitud: raceTarget } = await afterCrash.createRequest({
    kind: "approval",
    prompt: "Decisión concurrente",
    action: "approve.op",
    recipient: "demo",
    scope: "allow_once",
  });
  const pcId = randomUUID();
  const mobileId = randomUUID();
  const [r1, r2] = await Promise.allSettled([
    afterCrash.respond(raceTarget.id, {
      requestId: pcId,
      approve: true,
      origin: "pc",
    }),
    afterCrash.respond(raceTarget.id, {
      requestId: mobileId,
      approve: false,
      origin: "movil",
    }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  const rejected = [r1, r2].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(
    rejected[0].reason.recibo.requestId,
    fulfilled[0].value.recibo.requestId,
  );

  // Repeat of winning requestId is idempotent
  const replay = await afterCrash.respond(raceTarget.id, {
    requestId: fulfilled[0].value.recibo.requestId,
    approve: false,
    origin: "pc",
  });
  assert.equal(replay.repetido, true);
  assert.equal(replay.recibo.decision, fulfilled[0].value.recibo.decision);

  await afterCrash.cerrar();
});

test("HTTP de solicitudes separa agente y usuario, persiste tras reiniciar aplicación y preserva /aprobaciones", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-req-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Test\n");

  const appOpts = {
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
  };
  let app = await createApplication(appOpts);
  t.after(() => app?.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let base = `http://127.0.0.1:${app.server.address().port}/api/v1`;

  const agentHeaders = {
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": "ambar",
    "x-sb-sesion": randomUUID(),
  };

  // Agent creates question
  const askRes = await fetch(`${base}/solicitudes/preguntar`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      titulo: "Confirmar alcance",
      pregunta: "¿Continuar con pruebas sintéticas?",
      opciones: ["Sí", "Detener"],
    }),
  }).then((r) => r.json());
  assert.equal(askRes.ok, true);
  const reqId = askRes.solicitud.id;

  // Agent CANNOT answer on behalf of user
  const agentRespond = await fetch(`${base}/solicitudes/responder`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      id: reqId,
      requestId: randomUUID(),
      option: "Sí",
    }),
  });
  assert.equal(agentRespond.status, 403);

  // Restart full application BEFORE user answers -> pending question survives
  await app.close();
  app = await createApplication(appOpts);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const appHeaders = await getCsrfHeaders(base);

  const listAfterRestart = await fetch(
    `${base}/solicitudes?kind=question`,
  ).then((r) => r.json());
  assert.equal(listAfterRestart.solicitudes.length, 1);
  assert.equal(listAfterRestart.solicitudes[0].status, "pendiente");

  // User resolves with CSRF -> repeat with same requestId -> conflict with different requestId
  const clientReqId = randomUUID();
  const res1 = await fetch(`${base}/solicitudes/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: reqId,
      requestId: clientReqId,
      option: "Sí",
    }),
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.recibo.requestId, clientReqId);

  const resDup = await fetch(`${base}/solicitudes/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: reqId,
      requestId: clientReqId,
      option: "No",
    }),
  }).then((r) => r.json());
  assert.equal(resDup.repetido, true);
  assert.equal(resDup.recibo.selectedOption, "Sí");

  const resConflict = await fetch(`${base}/solicitudes/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: reqId,
      requestId: randomUUID(),
      option: "Detener",
    }),
  });
  assert.equal(resConflict.status, 409);
  const conflictJson = await resConflict.json();
  assert.equal(conflictJson.recibo.requestId, clientReqId);

  // Delivery tracking + protected approval HTTP endpoints
  const delivRes = await fetch(`${base}/solicitudes/entrega`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ id: reqId, status: "confirmada" }),
  }).then((r) => r.json());
  assert.equal(delivRes.solicitud.status, "confirmada");

  const aprCreate = await fetch(`${base}/solicitudes/aprobacion`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({
      prompt: "¿Ejecutar cambio protegido?",
      action: "write_file",
      recipient: "nota-sintetica.md",
      cost: 0,
      contentHash: "sha-demo",
      scope: "allow_once",
    }),
  }).then((r) => r.json());
  const aprId = aprCreate.solicitud.id;

  const aprDecision = await fetch(`${base}/solicitudes/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: aprId,
      requestId: randomUUID(),
      approve: true,
    }),
  }).then((r) => r.json());
  assert.equal(aprDecision.solicitud.status, "confirmada");

  const execOk = await fetch(`${base}/solicitudes/verificar-ejecucion`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ id: aprId }),
  });
  assert.equal(execOk.status, 200);

  const execTampered = await fetch(`${base}/solicitudes/verificar-ejecucion`, {
    method: "POST",
    headers: agentHeaders,
    body: JSON.stringify({ id: aprId, recipient: "otro-archivo.md" }),
  });
  assert.equal(execTampered.status, 409);

  // Legacy approvals list remains untouched & empty array
  const legacyApprovals = await fetch(`${base}/aprobaciones`).then((r) =>
    r.json(),
  );
  assert.deepEqual(legacyApprovals, []);
});

test("regresión P1 solicitudes: valida igualdad operativa en requestId repetido, repara cola truncada antes de nuevas escrituras y detecta corrupción intermedia", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-req-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const storeDir = path.join(dir, "solicitudes");
  const s1 = await createUserRequestStore(storeDir);

  const reqKey = randomUUID();
  const first = await s1.createRequest({
    kind: "approval",
    requestId: reqKey,
    prompt: "Enviar correo a A",
    action: "send_email",
    recipient: "a@localhost.invalid",
    cost: 0,
    scope: "allow_once",
  });
  assert.equal(first.repetido, false);

  const sameReplay = await s1.createRequest({
    kind: "approval",
    requestId: reqKey,
    prompt: "Enviar correo a A",
    action: "send_email",
    recipient: "a@localhost.invalid",
    cost: 0,
    scope: "allow_once",
  });
  assert.equal(sameReplay.repetido, true);
  assert.equal(sameReplay.solicitud.id, first.solicitud.id);

  await assert.rejects(
    s1.createRequest({
      kind: "approval",
      requestId: reqKey,
      prompt: "Enviar correo a B",
      action: "send_email",
      recipient: "b@localhost.invalid",
      cost: 0,
      scope: "allow_once",
    }),
    { status: 409 },
  );

  const receipt1 = await s1.respond(first.solicitud.id, {
    requestId: randomUUID(),
    approve: true,
    by: "owner",
  });
  await s1.cerrar();

  // Simulate half-written tail without trailing newline
  await appendFile(path.join(storeDir, "solicitudes-journal.jsonl"), '{"op":');

  const s2 = await createUserRequestStore(storeDir);
  assert.equal(
    s2.get(first.solicitud.id).receipt.requestId,
    receipt1.recibo.requestId,
  );
  const req2 = await s2.createRequest({
    kind: "question",
    prompt: "Pregunta tras recuperación",
    options: ["Sí", "No"],
  });
  const req3 = await s2.createRequest({
    kind: "question",
    prompt: "Segunda pregunta tras recuperación",
  });
  await s2.respond(req2.solicitud.id, {
    requestId: randomUUID(),
    option: "Sí",
    by: "owner",
  });
  await s2.cerrar();

  // Second restart MUST succeed cleanly preserving all IDs, receipts, revisions
  const s3 = await createUserRequestStore(storeDir);
  assert.equal(s3.get(first.solicitud.id).status, "confirmada");
  assert.equal(s3.get(req2.solicitud.id).status, "respuesta_recibida");
  assert.equal(s3.get(req3.solicitud.id).status, "pendiente");
  await s3.cerrar();

  // Authentic middle corruption MUST still reject
  const corruptDir = path.join(dir, "solicitudes-bad");
  await mkdir(corruptDir, { recursive: true });
  const lines = (
    await readFile(path.join(storeDir, "solicitudes-journal.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  await writeFile(
    path.join(corruptDir, "solicitudes-journal.jsonl"),
    `${lines[0]}\n{"op":\n${lines[lines.length - 1]}\n`,
  );
  await assert.rejects(createUserRequestStore(corruptDir), SyntaxError);
});
