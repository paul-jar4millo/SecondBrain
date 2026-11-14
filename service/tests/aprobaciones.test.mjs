import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createApplication } from "../index.mjs";
import {
  ConflictoAprobacion,
  crearColaAprobaciones,
} from "../aprobaciones.mjs";

test("la decisión desbloquea una solicitud y se conserva tras reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let ahora = 1000;
  const cola = await crearColaAprobaciones(dir, { reloj: () => ahora });
  const solicitud = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "sintetica", cantidad: 7 },
  });
  assert.equal(cola.listar()[0].estado, "pendiente");
  assert.equal(cola.listar()[0].vence, 1801000);
  await cola.decidir(solicitud.id, true);
  assert.equal(await solicitud.esperar, "aprobada");
  await assert.rejects(cola.decidir(solicitud.id, false));
  await cola.cerrar();
  const reiniciada = await crearColaAprobaciones(dir, { reloj: () => ahora });
  assert.equal(reiniciada.listar()[0].estado, "aprobada");
  await reiniciada.cerrar();
});

test("una operación financiera de sala espera aprobación y la credencial de sala no puede decidir", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");
  let ahora = 1000;
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    aprobaciones: { reloj: () => ahora },
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
  const operacion = fetch(base + "/finance/ops", {
    method: "POST",
    headers,
    body: JSON.stringify({ op: "init", requestId: "test-1" }),
  });
  let solicitudes = [];
  for (let i = 0; i < 100 && solicitudes.length === 0; i++) {
    const r = await fetch(base + "/aprobaciones");
    if (r.ok) solicitudes = await r.json();
    if (!solicitudes.length)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(solicitudes.length, 1);
  const decision = JSON.stringify({ id: solicitudes[0].id, aprobar: true });
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
  assert.equal((await operacion).status, 200);
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
  let pendiente;
  for (let i = 0; i < 100 && !pendiente; i++) {
    const lista = await (await fetch(base + "/aprobaciones")).json();
    pendiente = lista.find((s) => s.estado === "pendiente");
    if (!pendiente) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pendiente);
  ahora += 1800000;
  const intento = JSON.stringify({ id: pendiente.id, aprobar: true });
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
  pendiente = null;
  for (let i = 0; i < 100 && !pendiente; i++) {
    const lista = await (await fetch(base + "/aprobaciones")).json();
    pendiente = lista.find((s) => s.estado === "pendiente");
    if (!pendiente) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pendiente);
  const negativa = JSON.stringify({ id: pendiente.id, aprobar: false });
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
  let ahora = 1000;
  const cola = await crearColaAprobaciones(dir, { reloj: () => ahora });
  const solicitud = await cola.solicitar({
    actor: "agente:lira",
    operacion: { op: "sintetica" },
  });
  ahora += 1800000;
  await assert.rejects(cola.decidir(solicitud.id, true));
  assert.equal(await solicitud.esperar, "expirada");
  assert.equal(cola.listar()[0].estado, "expirada");
  await cola.cerrar();
});

test("una espera interrumpida no se puede aprobar después de reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cola = await crearColaAprobaciones(dir);
  const solicitud = await cola.solicitar({
    actor: "agente:ambar",
    operacion: { op: "sintetica" },
  });
  await cola.cerrar();
  assert.equal(await solicitud.esperar, "interrumpida");
  const nueva = await crearColaAprobaciones(dir);
  assert.equal(nueva.listar()[0].estado, "interrumpida");
  await assert.rejects(nueva.decidir(solicitud.id, true));
  await nueva.cerrar();
});

test("decisiones simultáneas producen una sola resolución durable", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cola = await crearColaAprobaciones(dir);
  const solicitud = await cola.solicitar({
    actor: "agente:marina",
    operacion: { op: "sintetica" },
  });
  const decisiones = await Promise.allSettled([
    cola.decidir(solicitud.id, false),
    cola.decidir(solicitud.id, true),
  ]);
  assert.deepEqual(
    decisiones.map((d) => d.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(await solicitud.esperar, "rechazada");
  assert.equal(cola.listar()[0].estado, "rechazada");
  await cola.cerrar();
});

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";

test("repetir la respuesta con el mismo requestId devuelve el recibo sin volver a aplicarla", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let ahora = 5000;
  const cola = await crearColaAprobaciones(dir, { reloj: () => ahora });
  const s = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "x" },
  });
  const primera = await cola.decidir(s.id, true, {
    requestId: R1,
    por: "owner",
  });
  assert.equal(primera.repetido, false);
  assert.deepEqual(Object.keys(primera.recibo).sort(), [
    "aprobacionId",
    "decision",
    "por",
    "requestId",
    "resultado",
    "ts",
  ]);
  assert.equal(primera.recibo.decision, "aprobada");
  ahora += 60000;
  const segunda = await cola.decidir(s.id, true, {
    requestId: R1,
    por: "otro",
  });
  assert.equal(segunda.repetido, true);
  assert.deepEqual(segunda.recibo, primera.recibo);
  // The retry did not write another journal line nor change the resolution time.
  assert.equal(cola.listar()[0].resuelta, 5000);
  // Another id, even with the opposite decision, conflicts with the stored receipt.
  await assert.rejects(
    cola.decidir(s.id, false, { requestId: R2 }),
    (e) => e instanceof ConflictoAprobacion && e.recibo.requestId === R1,
  );
  await assert.rejects(cola.decidir(s.id, true), ConflictoAprobacion);
  await cola.cerrar();
  // The receipt lives in the same journal as the state: it survives a restart.
  const reiniciada = await crearColaAprobaciones(dir, { reloj: () => ahora });
  const tras = await reiniciada.decidir(s.id, true, { requestId: R1 });
  assert.equal(tras.repetido, true);
  assert.equal(tras.recibo.por, "owner");
  await reiniciada.cerrar();
});

test("un requestId no puede reutilizarse en otra solicitud y se valida su formato", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cola = await crearColaAprobaciones(dir);
  const a = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "a" },
  });
  const b = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "b" },
  });
  await assert.rejects(
    cola.decidir(a.id, true, { requestId: "no-uuid" }),
    /inválida/,
  );
  await cola.decidir(a.id, true, { requestId: R1 });
  await assert.rejects(
    cola.decidir(b.id, true, { requestId: R1 }),
    ConflictoAprobacion,
  );
  assert.equal(cola.listar().find((r) => r.id === b.id).estado, "pendiente");
  // Without requestId a receipt is still stored, with a generated one.
  const sin = await cola.decidir(b.id, false);
  assert.match(sin.recibo.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(sin.recibo.decision, "rechazada");
  await cola.cerrar();
});

test("dos respuestas simultáneas: mismo requestId aplica una vez; ids distintos, solo gana una", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-recibo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cola = await crearColaAprobaciones(dir);
  const a = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "a" },
  });
  const iguales = await Promise.all([
    cola.decidir(a.id, true, { requestId: R1 }),
    cola.decidir(a.id, true, { requestId: R1 }),
    cola.decidir(a.id, true, { requestId: R1 }),
  ]);
  assert.deepEqual(iguales.map((r) => r.repetido).sort(), [false, true, true]);
  assert.equal(new Set(iguales.map((r) => r.recibo.ts)).size, 1);

  const b = await cola.solicitar({
    actor: "agente:menta",
    operacion: { op: "b" },
  });
  const distintas = await Promise.allSettled([
    cola.decidir(b.id, true, { requestId: R2 }),
    cola.decidir(b.id, false, {
      requestId: "33333333-3333-4333-8333-333333333333",
    }),
  ]);
  assert.deepEqual(
    distintas.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.ok(distintas[1].reason instanceof ConflictoAprobacion);
  assert.equal(distintas[1].reason.recibo.requestId, R2);
  assert.equal(await b.esperar, "aprobada");
  const lineas = (await readFile(path.join(dir, "aprobaciones.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean);
  // 2 requests + 1 resolution each: no duplicate resolution was ever journalled.
  assert.equal(lineas.length, 4);
  await cola.cerrar();
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
  const operacion = fetch(base + "/finance/ops", {
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
  const decidir = async (cuerpo) => {
    const r = await fetch(base + "/aprobaciones/decidir", {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
    });
    return { status: r.status, datos: await r.json() };
  };
  assert.equal(
    (await decidir({ id, aprobar: true, requestId: "no" })).status,
    400,
  );
  const primera = await decidir({ id, aprobar: true, requestId: R1 });
  assert.equal(primera.status, 200);
  assert.equal(primera.datos.repetido, false);
  assert.equal(primera.datos.recibo.requestId, R1);
  assert.equal((await operacion).status, 200);
  const repetida = await decidir({ id, aprobar: true, requestId: R1 });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.datos.repetido, true);
  assert.deepEqual(repetida.datos.recibo, {
    ...primera.datos.recibo,
    resultado: "Aplicada: la operación se guardó.",
  });
  const otra = await decidir({ id, aprobar: false, requestId: R2 });
  assert.equal(otra.status, 409);
  assert.equal(otra.datos.recibo.requestId, R1);
});
