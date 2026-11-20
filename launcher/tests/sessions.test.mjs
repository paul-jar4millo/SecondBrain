import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSessionRegistry } from "../sessions.mjs";

test("persiste sesiones concurrentes con índices de copia distintos y recupera sesiones interrumpidas", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-sesiones-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archivo = path.join(dir, "estado.json");
  const registro = await openSessionRegistry(archivo);
  const eventos = [];
  registro.subscribe((estado) => eventos.push(estado));
  const [a, b] = await Promise.all([
    registro.crear({
      motor: "codex",
      origen: "sala",
      encargo: "x".repeat(5000),
    }),
    registro.crear({ motor: "codex", origen: "cron" }),
  ]);
  assert.equal(a.encargo.length, 4000);
  assert.equal(b.encargo, null);
  assert.ok(!Number.isNaN(Date.parse(a.creada)));
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.copia, b.copia].sort(), [0, 1]);
  await registro.actualizar(a.id, {
    estado: "terminada",
    ultimaAccion: "Listo",
  });
  const disco = JSON.parse(await readFile(archivo, "utf8"));
  assert.equal(disco.length, 2);
  assert.equal(eventos.length, 3);
  const recuperado = await openSessionRegistry(archivo);
  assert.equal(
    recuperado.leer().find((s) => s.id === a.id).estado,
    "terminada",
  );
  assert.equal(
    recuperado.leer().find((s) => s.id === b.id).estado,
    "interrumpida",
  );
  const c = await recuperado.crear({ motor: "codex", origen: "sala" });
  assert.equal(c.copia, 0);
});

test("rechaza motores, orígenes y cambios de identidad inválidos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-sesiones-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  await assert.rejects(registro.crear({ motor: "otro", origen: "sala" }));
  await assert.rejects(registro.crear({ motor: "claude", origen: "otro" }));
  const s = await registro.crear({ motor: "claude", origen: "sala" });
  await assert.rejects(registro.actualizar(s.id, { motor: "codex" }));
});

test("restart releases an idle interactive harness while retaining its native identity and replay", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  const registro = await openSessionRegistry(file);
  const s = await registro.crear({
    motor: "claude",
    origen: "sala",
    harness: true,
    espacioId: "p1",
  });
  await registro.actualizar(s.id, {
    estado: "terminada",
    interactiva: true,
    terminal: "saved screen",
    conversacionId: s.id,
  });
  const reopened = await openSessionRegistry(file);
  const saved = reopened.leer()[0];
  assert.equal(saved.interactiva, false);
  assert.equal(saved.estado, "interrumpida");
  assert.equal(saved.terminal, "saved screen");
  assert.equal(saved.conversacionId, s.id);
});

test("elimina solo conversaciones detenidas y no deja que el observador las reviva", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-sesiones-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  const s = await registro.crear({
    motor: "claude",
    origen: "sala",
    encargo: "Plan privado",
  });
  await registro.actualizar(s.id, { estado: "trabajando" });
  await assert.rejects(registro.eliminar(s.id), /Detén la sesión/);
  await registro.actualizar(s.id, {
    estado: "terminada",
    conversacionId: "c1",
    mensajes: [{ rol: "user", texto: "Plan privado" }],
  });
  await registro.eliminar(s.id);
  const borrada = registro.leer().find((x) => x.id === s.id);
  assert.equal(borrada.eliminada, true);
  assert.equal(borrada.conversacionId, "c1");
  assert.equal(JSON.stringify(borrada).includes("Plan privado"), false);
  await registro.actualizar(s.id, { mensajes: [{ rol: "user", texto: "x" }] });
  assert.equal(registro.leer().find((x) => x.id === s.id).mensajes, undefined);
  await assert.rejects(registro.eliminar(s.id), /inexistente/);
});
