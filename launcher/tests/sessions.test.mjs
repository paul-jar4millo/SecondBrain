import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSessionRegistry } from "../sessions.mjs";

test("persiste sesiones concurrentes con índices de copia distintos y recupera sesiones interrumpidas", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-sesiones-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "estado.json");
  const registry = await openSessionRegistry(file);
  const events = [];
  registry.subscribe((state) => events.push(state));
  const [a, b] = await Promise.all([
    registry.crear({
      motor: "codex",
      origen: "sala",
      encargo: "x".repeat(5000),
    }),
    registry.crear({ motor: "codex", origen: "cron" }),
  ]);
  assert.equal(a.encargo.length, 4000);
  assert.equal(b.encargo, null);
  assert.ok(!Number.isNaN(Date.parse(a.creada)));
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.copia, b.copia].sort(), [0, 1]);
  await registry.actualizar(a.id, {
    estado: "terminada",
    ultimaAccion: "Listo",
  });
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.length, 2);
  assert.equal(events.length, 3);
  const recuperado = await openSessionRegistry(file);
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
  const registry = await openSessionRegistry(path.join(dir, "estado.json"));
  await assert.rejects(registry.crear({ motor: "otro", origen: "sala" }));
  await assert.rejects(registry.crear({ motor: "claude", origen: "otro" }));
  const s = await registry.crear({ motor: "claude", origen: "sala" });
  await assert.rejects(registry.actualizar(s.id, { motor: "codex" }));
});

test("restart releases an idle interactive harness while retaining its native identity and replay", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  const registry = await openSessionRegistry(file);
  const s = await registry.crear({
    motor: "claude",
    origen: "sala",
    harness: true,
    espacioId: "p1",
  });
  await registry.actualizar(s.id, {
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
  const registry = await openSessionRegistry(path.join(dir, "estado.json"));
  const s = await registry.crear({
    motor: "claude",
    origen: "sala",
    encargo: "Plan privado",
  });
  await registry.actualizar(s.id, { estado: "trabajando" });
  await assert.rejects(registry.eliminar(s.id), /Detén la sesión/);
  await registry.actualizar(s.id, {
    estado: "terminada",
    conversacionId: "c1",
    mensajes: [{ rol: "user", texto: "Plan privado" }],
  });
  await registry.eliminar(s.id);
  const borrada = registry.leer().find((x) => x.id === s.id);
  assert.equal(borrada.eliminada, true);
  assert.equal(borrada.conversacionId, "c1");
  assert.equal(JSON.stringify(borrada).includes("Plan privado"), false);
  await registry.actualizar(s.id, { mensajes: [{ rol: "user", texto: "x" }] });
  assert.equal(registry.leer().find((x) => x.id === s.id).mensajes, undefined);
  await assert.rejects(registry.eliminar(s.id), /inexistente/);
});
