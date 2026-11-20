import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createApplication } from "../index.mjs";
import { ApprovalConflict, createApprovalQueue } from "../approvals.mjs";

test("la decisión desbloquea una solicitud y se conserva tras reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000;
  const queue = await createApprovalQueue(dir, { reloj: () => now });
  const request = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "sintetica", cantidad: 7 },
  });
  assert.equal(queue.listar()[0].estado, "pendiente");
  assert.equal(queue.listar()[0].vence, 1801000);
  await queue.decidir(request.id, true);
  assert.equal(await request.esperar, "aprobada");
  await assert.rejects(queue.decidir(request.id, false));
  await queue.cerrar();
  const reiniciada = await createApprovalQueue(dir, { reloj: () => now });
  assert.equal(reiniciada.listar()[0].estado, "aprobada");
  await reiniciada.cerrar();
});

test("una operación financiera de sala espera aprobación y la credencial de sala no puede decidir", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");
  let now = 1000;
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    aprobaciones: { reloj: () => now },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const headers = {
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": "menta",
  };
  const operation = fetch(base + "/finance/ops", {
    method: "POST",
    headers,
    body: JSON.stringify({ op: "init", requestId: "test-1" }),
  });
  let requests = [];
  for (let i = 0; i < 100 && requests.length === 0; i++) {
    const r = await fetch(base + "/aprobaciones");
    if (r.ok) requests = await r.json();
    if (!requests.length)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(requests.length, 1);
  const decision = JSON.stringify({ id: requests[0].id, aprobar: true });
  assert.equal(
    (
      await fetch(base + "/aprobaciones/decidir", {
        method: "POST",
        headers,
        body: decision,
      })
    ).status,
    403,
  );
  const csrf = await fetch(base + "/auth/csrf");
  const { token } = await csrf.json();
  const appHeaders = {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  assert.equal(
    (
      await fetch(base + "/aprobaciones/decidir", {
        method: "POST",
        headers: appHeaders,
        body: decision,
      })
    ).status,
    200,
  );
  assert.equal((await operation).status, 200);
  const bloquear = await fetch(base + "/vault/note", {
    method: "POST",
    headers,
    body: JSON.stringify({
      path: "02-Areas/Finanzas/Datos-financieros.md",
      content: "# alterado",
      expectedHash: null,
    }),
  });
  assert.equal(bloquear.status, 400);
  const expirar = fetch(base + "/finance/ops", {
    method: "POST",
    headers,
    body: JSON.stringify({
      op: "card-add",
      name: "Sintética",
      limit: 10,
      last4: "1234",
    }),
  });
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    const list = await (await fetch(base + "/aprobaciones")).json();
    pending = list.find((s) => s.estado === "pendiente");
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending);
  now += 1800000;
  const intento = JSON.stringify({ id: pending.id, aprobar: true });
  assert.equal(
    (
      await fetch(base + "/aprobaciones/decidir", {
        method: "POST",
        headers: appHeaders,
        body: intento,
      })
    ).status,
    409,
  );
  assert.equal((await expirar).status, 403);
  const overview = await (await fetch(base + "/finance/overview")).json();
  assert.equal(overview.cards.length, 0);
  const rechazar = fetch(base + "/finance/ops", {
    method: "POST",
    headers,
    body: JSON.stringify({
      op: "card-add",
      name: "Otra sintética",
      limit: 20,
      last4: "2345",
    }),
  });
  pending = null;
  for (let i = 0; i < 100 && !pending; i++) {
    const lista = await (await fetch(base + "/aprobaciones")).json();
    pending = lista.find((s) => s.estado === "pendiente");
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending);
  const negativa = JSON.stringify({ id: pending.id, aprobar: false });
  assert.equal(
    (
      await fetch(base + "/aprobaciones/decidir", {
        method: "POST",
        headers: appHeaders,
        body: negativa,
      })
    ).status,
    200,
  );
  assert.equal((await rechazar).status, 403);
  assert.equal(
    (await (await fetch(base + "/finance/overview")).json()).cards.length,
    0,
  );
});

test("el vencimiento rechaza, incluso si la decisión llega después del plazo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000;
  const queue = await createApprovalQueue(dir, { reloj: () => now });
  const request = await queue.solicitar({
    actor: "agente:lira",
    operacion: { op: "sintetica" },
  });
  now += 1800000;
  await assert.rejects(queue.decidir(request.id, true));
  assert.equal(await request.esperar, "expirada");
  assert.equal(queue.listar()[0].estado, "expirada");
  await queue.cerrar();
});

test("una espera interrumpida no se puede aprobar después de reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queue = await createApprovalQueue(dir);
  const request = await queue.solicitar({
    actor: "agente:ambar",
    operacion: { op: "sintetica" },
  });
  await queue.cerrar();
  assert.equal(await request.esperar, "interrumpida");
  const created = await createApprovalQueue(dir);
  assert.equal(created.listar()[0].estado, "interrumpida");
  await assert.rejects(created.decidir(request.id, true));
  await created.cerrar();
});

test("decisiones simultáneas producen una sola resolución durable", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queue = await createApprovalQueue(dir);
  const request = await queue.solicitar({
    actor: "agente:marina",
    operacion: { op: "sintetica" },
  });
  const decisiones = await Promise.allSettled([
    queue.decidir(request.id, false),
    queue.decidir(request.id, true),
  ]);
  assert.deepEqual(
    decisiones.map((d) => d.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(await request.esperar, "rechazada");
  assert.equal(queue.listar()[0].estado, "rechazada");
  await queue.cerrar();
});

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";

test("repetir la respuesta con el mismo requestId devuelve el recibo sin volver a aplicarla", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 5000;
  const queue = await createApprovalQueue(dir, { reloj: () => now });
  const s = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "x" },
  });
  const first = await queue.decidir(s.id, true, {
    requestId: R1,
    por: "owner",
  });
  assert.equal(first.repetido, false);
  assert.deepEqual(Object.keys(first.recibo).sort(), [
    "aprobacionId",
    "decision",
    "por",
    "requestId",
    "resultado",
    "ts",
  ]);
  assert.equal(first.recibo.decision, "aprobada");
  now += 60000;
  const second = await queue.decidir(s.id, true, {
    requestId: R1,
    por: "otro",
  });
  assert.equal(second.repetido, true);
  assert.deepEqual(second.recibo, first.recibo);
  // The retry did not write another journal line nor change the resolution time.
  assert.equal(queue.listar()[0].resuelta, 5000);
  // Another id, even with the opposite decision, conflicts with the stored receipt.
  await assert.rejects(
    queue.decidir(s.id, false, { requestId: R2 }),
    (e) => e instanceof ApprovalConflict && e.recibo.requestId === R1,
  );
  await assert.rejects(queue.decidir(s.id, true), ApprovalConflict);
  await queue.cerrar();
  // The receipt lives in the same journal as the state: it survives a restart.
  const reiniciada = await createApprovalQueue(dir, { reloj: () => now });
  const tras = await reiniciada.decidir(s.id, true, { requestId: R1 });
  assert.equal(tras.repetido, true);
  assert.equal(tras.recibo.por, "owner");
  await reiniciada.cerrar();
});

test("un requestId no puede reutilizarse en otra solicitud y se valida su formato", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queue = await createApprovalQueue(dir);
  const a = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "a" },
  });
  const b = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "b" },
  });
  await assert.rejects(
    queue.decidir(a.id, true, { requestId: "no-uuid" }),
    /inválida/,
  );
  await queue.decidir(a.id, true, { requestId: R1 });
  await assert.rejects(
    queue.decidir(b.id, true, { requestId: R1 }),
    ApprovalConflict,
  );
  assert.equal(queue.listar().find((r) => r.id === b.id).estado, "pendiente");
  // Without requestId a receipt is still stored, with a generated one.
  const sin = await queue.decidir(b.id, false);
  assert.match(sin.recibo.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(sin.recibo.decision, "rechazada");
  await queue.cerrar();
});

test("dos respuestas simultáneas: mismo requestId aplica una vez; ids distintos, solo gana una", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queue = await createApprovalQueue(dir);
  const a = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "a" },
  });
  const iguales = await Promise.all([
    queue.decidir(a.id, true, { requestId: R1 }),
    queue.decidir(a.id, true, { requestId: R1 }),
    queue.decidir(a.id, true, { requestId: R1 }),
  ]);
  assert.deepEqual(iguales.map((r) => r.repetido).sort(), [false, true, true]);
  assert.equal(new Set(iguales.map((r) => r.recibo.ts)).size, 1);

  const b = await queue.solicitar({
    actor: "agente:menta",
    operacion: { op: "b" },
  });
  const distintas = await Promise.allSettled([
    queue.decidir(b.id, true, { requestId: R2 }),
    queue.decidir(b.id, false, {
      requestId: "33333333-3333-4333-8333-333333333333",
    }),
  ]);
  assert.deepEqual(
    distintas.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.ok(distintas[1].reason instanceof ApprovalConflict);
  assert.equal(distintas[1].reason.recibo.requestId, R2);
  assert.equal(await b.esperar, "aprobada");
  const lines = (await readFile(path.join(dir, "aprobaciones.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean);
  // 2 requests + 1 resolution each: no duplicate resolution was ever journalled.
  assert.equal(lines.length, 4);
  await queue.cerrar();
});

test("la ruta decide con requestId: reintento 200 repetido y otro id 409 con el recibo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");
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
  const operation = fetch(base + "/finance/ops", {
    method: "POST",
    headers: {
      authorization: "Bearer room-secret",
      "content-type": "application/json",
      "x-sb-agente": "menta",
    },
    body: JSON.stringify({ op: "init", requestId: "r-1" }),
  });
  let id;
  for (let i = 0; i < 100 && !id; i++) {
    id = (await (await fetch(base + "/aprobaciones")).json())[0]?.id;
    if (!id) await new Promise((r) => setTimeout(r, 10));
  }
  const csrf = await fetch(base + "/auth/csrf");
  const { token } = await csrf.json();
  const headers = {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  const decide = async (cuerpo) => {
    const r = await fetch(base + "/aprobaciones/decidir", {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
    });
    return { status: r.status, datos: await r.json() };
  };
  assert.equal(
    (await decide({ id, aprobar: true, requestId: "no" })).status,
    400,
  );
  const first = await decide({ id, aprobar: true, requestId: R1 });
  assert.equal(first.status, 200);
  assert.equal(first.datos.repetido, false);
  assert.equal(first.datos.recibo.requestId, R1);
  assert.equal((await operation).status, 200);
  const repetida = await decide({ id, aprobar: true, requestId: R1 });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.datos.repetido, true);
  assert.deepEqual(repetida.datos.recibo, {
    ...first.datos.recibo,
    resultado: "Aplicada: la operación se guardó.",
  });
  const otra = await decide({ id, aprobar: false, requestId: R2 });
  assert.equal(otra.status, 409);
  assert.equal(otra.datos.recibo.requestId, R1);
});
