import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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
import { createApplication } from "../index.mjs";
import { createWorkOrderStore } from "../work-orders.mjs";
import { getCsrfHeaders } from "./helpers/csrf.mjs";

function sampleTeam() {
  return [
    {
      id: "coord-ambar",
      characterId: "ambar",
      engine: "claude",
      model: "claude-opus-4-7",
      effort: "high",
      role: "Coordinadora general",
      responsibility: "Integrar entregables y validar criterios.",
      coordinator: true,
      toolProfileId: "coordinacion",
    },
    {
      id: "exec-menta",
      characterId: "menta",
      engine: "codex",
      model: "gpt-5.4",
      effort: "high",
      role: "Implementadora técnica",
      responsibility: "Escribir código y pruebas.",
      coordinator: false,
      toolProfileId: "ejecucion",
    },
  ];
}

test("almacén de encargos valida tarjetas 1..4, congela manifiesto y soporta edición en caliente", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-wo-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let tick = 0;
  const clock = () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString();
  const store = await createWorkOrderStore(dir, { clock });

  await assert.rejects(
    store.createWorkOrder({
      title: "Equipo vacío",
      objective: "Debe fallar",
      acceptanceCriteria: [{ text: "Criterio" }],
      team: [],
    }),
    { status: 400 },
  );

  await assert.rejects(
    store.createWorkOrder({
      title: "Exceso de tarjetas",
      objective: "Más de cuatro tarjetas",
      acceptanceCriteria: [{ text: "Criterio" }],
      team: [
        ...sampleTeam(),
        {
          id: "m3",
          characterId: "lira",
          engine: "agy",
          model: "gemini-4",
          role: "Investigadora",
          responsibility: "Explorar fuentes",
          coordinator: false,
        },
        {
          id: "m4",
          characterId: "marina",
          engine: "deepseek",
          model: "deepseek-chat",
          role: "Verificadora",
          responsibility: "Auditar",
          coordinator: false,
        },
        {
          id: "m5",
          characterId: "lira",
          engine: "agy",
          model: "gemini-4",
          role: "Extra",
          responsibility: "Sobra",
          coordinator: false,
        },
      ],
    }),
    { status: 400 },
  );

  await assert.rejects(
    store.createWorkOrder({
      title: "Dos coordinadoras",
      objective: "Solo una coordinadora permitida",
      acceptanceCriteria: [{ text: "Criterio" }],
      team: sampleTeam().map((m) => ({ ...m, coordinator: true })),
    }),
    { status: 400 },
  );

  const created = await store.createWorkOrder({
    title: "Encargo de prueba",
    projectId: "proj-sintetico",
    objective: "Contratos persistentes de encargos y eventos",
    expectedOutcome: "Pruebas verdes",
    acceptanceCriteria: [
      { id: "c1", text: "Manifiesto congelado" },
      { id: "c2", text: "Verificación explícita" },
    ],
    team: sampleTeam(),
  });
  assert.equal(created.code, "ENC-001");
  assert.equal(created.status, "borrador");
  assert.equal(created.manifest, null);

  const started = await store.startWorkOrder(created.id);
  assert.equal(started.status, "en_curso");
  assert.ok(started.manifest?.sha256);
  const frozenHash = started.manifest.sha256;
  const frozenSnapshotCount = started.manifest.team.length;

  await store.appendEvent(created.id, {
    sourceId: "coord-ambar",
    type: "turn.started",
    payload: { sessionId: "s-1" },
  });
  const active = store.get(created.id);
  assert.equal(active.status, "en_curso");

  const enqueued = await store.enqueueMessage(created.id, {
    clientMessageId: "store-msg-1",
    mode: "send",
    text: "Comando de prueba",
  });
  assert.equal(enqueued.command.deliveryStatus, "recibido");
  const deliveredOrder = await store.updateCommandDeliveryStatus(
    created.id,
    enqueued.command.id,
    "entregado",
  );
  assert.equal(deliveredOrder.commands[0].deliveryStatus, "entregado");

  // Hot team update preserves immutable frozen manifest & creates structured handoff
  const updatedHot = await store.updateTeam(created.id, {
    applyMode: "handoff",
    decisions: ["Congelar interfaz HTTP"],
    pending: ["Agregar verificadora Marina"],
    team: [
      ...sampleTeam(),
      {
        id: "verif-marina",
        characterId: "marina",
        engine: "codex",
        model: "gpt-5.4",
        role: "Verificadora independiente",
        responsibility: "Revisar criterios",
        coordinator: false,
        toolProfileId: "investigacion",
      },
    ],
  });
  assert.equal(updatedHot.teamRevision, 2);
  assert.equal(updatedHot.manifest.sha256, frozenHash);
  assert.equal(updatedHot.manifest.team.length, frozenSnapshotCount);
  assert.equal(updatedHot.pendingTeamRevision.preservesActiveManifest, true);
  assert.equal(updatedHot.handoffs.length, 1);

  // turn.completed moves to verificando, NEVER directly to completado
  await store.appendEvent(created.id, {
    sourceId: "coord-ambar",
    type: "artifact.published",
    payload: { fileRef: "docs/resultado.md", hash: "abc123" },
  });
  await store.appendEvent(created.id, {
    sourceId: "coord-ambar",
    type: "turn.completed",
    payload: { summary: "Trabajo preliminar" },
  });
  assert.equal(store.get(created.id).status, "verificando");
  assert.equal(store.get(created.id).artifacts.length, 1);

  await assert.rejects(store.verifyWorkOrder(created.id, { complete: true }), {
    status: 409,
  });

  const completed = await store.verifyWorkOrder(created.id, {
    criteriaUpdates: [
      { id: "c1", checked: true, evidenceRefs: ["hash:" + frozenHash] },
      { id: "c2", checked: true, evidenceRefs: ["test:ok"] },
    ],
    complete: true,
    note: "Todo verificado",
  });
  assert.equal(completed.status, "completado");

  // Simulate trailing half-written JSONL line and restart store
  await store.close();
  await appendFile(path.join(dir, "encargos-journal.jsonl"), '{"corrupt":\n');
  const reopened = await createWorkOrderStore(dir, { clock });
  const rebuilt = reopened.get(created.id);
  assert.equal(rebuilt.status, "completado");
  assert.equal(rebuilt.manifest.sha256, frozenHash);
  assert.equal(rebuilt.handoffs.length, 1);
  assert.equal(rebuilt.artifacts.length, 1);
  await reopened.close();
});

test("encargos garantizan idempotencia de comandos, cursor monotónico y visibilidad directa filtrada en servidor", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-wo-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Refugio Sintético\n");

  const responderCalls = [];
  const launcher = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    if (req.url?.includes("/conversation/answer")) {
      responderCalls.push(JSON.parse(bodyText));
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true }));
    }
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => new Promise((r) => launcher.close(r)));

  const appOpts = {
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${launcher.address().port}`,
      token: "ctrl",
    },
  };
  let app = await createApplication(appOpts);
  t.after(() => app?.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  let appHeaders = await getCsrfHeaders(base);

  const createRes = await fetch(`${base}/encargos`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      title: "Encargo HTTP",
      objective: "Probar visibilidad e idempotencia",
      acceptanceCriteria: [{ id: "crit-1", text: "Filtrado correcto" }],
      team: sampleTeam(),
    }),
  });
  assert.equal(createRes.status, 201);
  const { encargo } = await createRes.json();

  // Room agent is denied (403) on user-only endpoints
  const agentHeaders = (agente) => ({
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": agente,
  });
  for (const [route, payload] of [
    ["/encargos", {}],
    ["/encargos/iniciar", { workOrderId: encargo.id }],
    [
      "/encargos/mensajes",
      { workOrderId: encargo.id, clientMessageId: "m-unauth", text: "hola" },
    ],
    ["/encargos/verificar", { workOrderId: encargo.id, complete: true }],
  ]) {
    const r = await fetch(`${base}${route}`, {
      method: "POST",
      headers: agentHeaders("menta"),
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 403, `Agente de sala no debe acceder a ${route}`);
  }

  // Start and send idempotent team message + direct message to Menta
  const startRes = await fetch(`${base}/encargos/iniciar`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({ workOrderId: encargo.id }),
  });
  assert.equal(startRes.status, 200);

  const msgPayload = {
    workOrderId: encargo.id,
    clientMessageId: "cmd-team-1",
    recipient: { scope: "equipo" },
    mode: "send",
    text: "Instrucción pública del equipo",
  };
  const firstMsg = await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify(msgPayload),
  }).then((r) => r.json());
  const dupMsg = await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify(msgPayload),
  }).then((r) => r.json());
  assert.equal(firstMsg.repetido, false);
  assert.equal(dupMsg.repetido, true);
  assert.equal(dupMsg.command.id, firstMsg.command.id);
  assert.equal(dupMsg.snapshot.commands.length, 1);

  await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      workOrderId: encargo.id,
      clientMessageId: "cmd-direct-menta",
      recipient: { scope: "directo", memberId: "exec-menta" },
      mode: "queue",
      text: "Secreto directo solo para Menta",
    }),
  });

  // Server-side visibility filtering:
  // 1) Menta (matching agent) sees both team and direct message
  const mentaFeed = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=0`,
    { headers: agentHeaders("menta") },
  ).then((r) => r.json());
  assert.ok(
    mentaFeed.events.some(
      (e) => e.payload?.text === "Secreto directo solo para Menta",
    ),
  );

  // 2) Ambar (or even attempting to spoof ?recipientScope=todos or ?memberId=exec-menta) MUST NOT see Menta's direct message
  const ambarSpoof = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&recipientScope=todos&memberId=exec-menta`,
    { headers: agentHeaders("ambar") },
  ).then((r) => r.json());
  assert.equal(
    ambarSpoof.events.some(
      (e) => e.payload?.text === "Secreto directo solo para Menta",
    ),
    false,
  );
  assert.ok(
    ambarSpoof.events.some(
      (e) => e.payload?.text === "Instrucción pública del equipo",
    ),
  );

  // 3) Reconnection cursor delivers only subsequent events
  const cursor = mentaFeed.cursor;
  await fetch(`${base}/encargos/eventos`, {
    method: "POST",
    headers: agentHeaders("menta"),
    body: JSON.stringify({
      workOrderId: encargo.id,
      type: "turn.completed",
      payload: { summary: "Completado paso 1" },
    }),
  });
  const tailFeed = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=${cursor}`,
    { headers: agentHeaders("menta") },
  ).then((r) => r.json());
  assert.equal(tailFeed.events.length, 1);
  assert.equal(tailFeed.events[0].type, "turn.completed");
  assert.ok(tailFeed.cursor > cursor);

  // /agentes/conversacion/responder accepts string, string[], and structured form content
  for (const payload of [
    { answers: { q1: "texto simple" } },
    { answers: { q1: ["opción A", "opción B"] } },
    {
      decision: "accept",
      content: {
        entorno: "staging",
        reintentos: 3,
        confirmar: false,
        etiquetas: ["uno", "dos"],
      },
    },
  ]) {
    const r = await fetch(`${base}/agentes/conversacion/responder`, {
      method: "POST",
      headers: appHeaders,
      body: JSON.stringify({
        id: randomUUID(),
        requestId: randomUUID(),
        responseId: randomUUID(),
        ...payload,
      }),
    });
    assert.equal(r.status, 200);
  }
  assert.equal(responderCalls.length, 3);
  assert.deepEqual(responderCalls[1].answers.q1, ["opción A", "opción B"]);
  assert.deepEqual(responderCalls[2].content, {
    entorno: "staging",
    reintentos: 3,
    confirmar: false,
    etiquetas: ["uno", "dos"],
  });

  // Full restart preserves exact work order state & event cursor
  await app.close();
  app = await createApplication(appOpts);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;

  const rebuiltFeed = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=0`,
  ).then((r) => r.json());
  assert.equal(rebuiltFeed.snapshot.status, "verificando");
  assert.equal(rebuiltFeed.snapshot.commands.length, 2);
  assert.equal(rebuiltFeed.events.length, tailFeed.cursor);

  const persistedJournal = await readFile(
    path.join(dir, "data", "encargos", "encargos-journal.jsonl"),
    "utf8",
  );
  assert.ok(persistedJournal.includes("ENC-001"));
});

test("regresión P2 directos: getSnapshotAndFeed filtra commands directos además de eventos manteniendo vista completa del propietario", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-wo-direct-proj-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Directos Sintéticos\n");

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

  const team = [
    ...sampleTeam(),
    {
      id: "inv-lira",
      characterId: "lira",
      engine: "agy",
      model: "gemini-3.8-flash",
      role: "Investigadora",
      responsibility: "Verificar",
      coordinator: false,
      toolProfileId: "investigacion",
    },
  ];
  const { encargo } = await fetch(`${base}/encargos`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      title: "Visibilidad snapshot y feed",
      objective:
        "Comprobar aislamiento de mensajes directos en commands y events",
      acceptanceCriteria: [{ text: "Sin filtración a otras tarjetas" }],
      team,
    }),
  }).then((r) => r.json());

  await fetch(`${base}/encargos/iniciar`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({ workOrderId: encargo.id }),
  });

  await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      workOrderId: encargo.id,
      clientMessageId: "c-team",
      recipient: { scope: "equipo" },
      text: "Aviso general equipo",
    }),
  });
  await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      workOrderId: encargo.id,
      clientMessageId: "c-direct-a",
      recipient: { scope: "directo", memberId: "coord-ambar" },
      text: "Confidencial solo A",
    }),
  });
  await fetch(`${base}/encargos/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      workOrderId: encargo.id,
      clientMessageId: "c-direct-b",
      recipient: { scope: "directo", memberId: "exec-menta" },
      text: "Confidencial solo B",
    }),
  });

  // 1) Store projection directly: B must not see A's direct command or event
  const feedBStore = app.workOrders.getSnapshotAndFeed(encargo.id, {
    cursor: 0,
    memberId: "exec-menta",
  });
  assert.deepEqual(
    feedBStore.snapshot.commands.map((c) => c.text),
    ["Aviso general equipo", "Confidencial solo B"],
  );
  assert.equal(
    feedBStore.snapshot.commands.some((c) => c.text === "Confidencial solo A"),
    false,
  );
  assert.equal(
    feedBStore.events.some((e) => e.payload?.text === "Confidencial solo A"),
    false,
  );

  // 2) Store projection for third member Lira: only team command & team events, ZERO directs
  const feedLiraStore = app.workOrders.getSnapshotAndFeed(encargo.id, {
    cursor: 0,
    memberId: "inv-lira",
  });
  assert.deepEqual(
    feedLiraStore.snapshot.commands.map((c) => c.text),
    ["Aviso general equipo"],
  );
  assert.equal(
    feedLiraStore.events.some((e) => e.visibility === "directo"),
    false,
  );

  // 3) Store projection for team scope hides ALL direct commands
  const feedEquipo = app.workOrders.getSnapshotAndFeed(encargo.id, {
    cursor: 0,
    recipientScope: "equipo",
  });
  assert.deepEqual(
    feedEquipo.snapshot.commands.map((c) => c.text),
    ["Aviso general equipo"],
  );

  // 4) HTTP projections: normal Menta sees own direct + team, NOT A; spoofing A yields team only
  const httpMenta = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=0`,
    {
      headers: {
        authorization: "Bearer room-secret",
        "x-sb-agente": "menta",
      },
    },
  ).then((r) => r.json());
  assert.deepEqual(
    httpMenta.snapshot.commands.map((c) => c.text),
    ["Aviso general equipo", "Confidencial solo B"],
  );
  const httpMentaSpoof = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=0&recipientScope=todos&memberId=coord-ambar`,
    {
      headers: {
        authorization: "Bearer room-secret",
        "x-sb-agente": "menta",
      },
    },
  ).then((r) => r.json());
  assert.deepEqual(
    httpMentaSpoof.snapshot.commands.map((c) => c.text),
    ["Aviso general equipo"],
  );

  // 4) Authorized owner keeps full visibility without altering commands
  const httpOwner = await fetch(
    `${base}/encargos/detalle?id=${encargo.id}&cursor=0`,
  ).then((r) => r.json());
  assert.equal(httpOwner.snapshot.commands.length, 3);
  assert.ok(
    httpOwner.events.some((e) => e.payload?.text === "Confidencial solo A"),
  );
  assert.ok(
    httpOwner.events.some((e) => e.payload?.text === "Confidencial solo B"),
  );
});

test("regresión P1 journal encargos: repara cola truncada sin newline en arranque antes de escribir más registros y detecta corrupción intermedia", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-wo-journal-repair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const storeDir = path.join(dir, "encargos");
  const s1 = await createWorkOrderStore(storeDir);
  const w1 = await s1.createWorkOrder({
    title: "Encargo 1",
    objective: "Sobrevivir dos reinicios",
    acceptanceCriteria: [{ text: "Ok" }],
    team: sampleTeam(),
  });
  const started1 = await s1.startWorkOrder(w1.id);
  const ev1 = await s1.appendEvent(w1.id, {
    sourceId: "coord-ambar",
    type: "artifact.published",
    payload: { fileRef: "docs/a.md", hash: "h1" },
  });
  await s1.close();

  // Half-written trailing tail WITHOUT trailing newline
  await appendFile(path.join(storeDir, "encargos-journal.jsonl"), '{"op":');

  const s2 = await createWorkOrderStore(storeDir);
  assert.equal(s2.get(w1.id).artifacts.length, 1);
  const w2 = await s2.createWorkOrder({
    title: "Encargo 2",
    objective: "Escrito tras reparar cola",
    acceptanceCriteria: [{ text: "Ok" }],
    team: sampleTeam(),
  });
  const w3 = await s2.createWorkOrder({
    title: "Encargo 3",
    objective: "Segundo registro tras reparar cola",
    acceptanceCriteria: [{ text: "Ok" }],
    team: sampleTeam(),
  });
  await s2.close();

  // Second restart MUST NOT throw SyntaxError and keeps all orders, events, versions
  const s3 = await createWorkOrderStore(storeDir);
  assert.equal(s3.get(w1.id).artifacts[0].hash, "h1");
  assert.equal(s3.get(w1.id).manifest.sha256, started1.manifest.sha256);
  const feedW1 = s3.getSnapshotAndFeed(w1.id, { cursor: 0 });
  assert.ok(feedW1.events.some((e) => e.id === ev1.event.id));
  assert.equal(s3.get(w2.id).code, "ENC-002");
  assert.equal(s3.get(w3.id).code, "ENC-003");
  await s3.close();

  // Mid-file corruption MUST throw SyntaxError
  const badDir = path.join(dir, "encargos-bad");
  await mkdir(badDir, { recursive: true });
  const lines = (
    await readFile(path.join(storeDir, "encargos-journal.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  await writeFile(
    path.join(badDir, "encargos-journal.jsonl"),
    `${lines[0]}\n{"op":\n${lines[lines.length - 1]}\n`,
  );
  await assert.rejects(createWorkOrderStore(badDir), SyntaxError);
});
