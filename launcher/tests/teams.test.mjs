import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTeams } from "../teams.mjs";

test("miembros intercambian mensajes y entregables, conservados tras reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const equipos = await openTeams(dir);
  const equipo = await equipos.crear("lider");
  await equipos.agregar(equipo.id, "lider", "hija1", "agy");
  await equipos.agregar(equipo.id, "lider", "hija2", "deepseek");
  await equipos.mensaje("lider", "hija1", "Busca X");
  await equipos.entregar("hija1", "Hallazgos", "Resultado sintético");
  assert.equal(equipos.bandeja("hija1")[0].texto, "Busca X");
  assert.equal(
    equipos.estado("lider").entregables[0].contenido,
    "Resultado sintético",
  );
  const recuperado = await openTeams(dir);
  assert.equal(recuperado.estado("hija2").miembros.length, 3);
  assert.equal(recuperado.bandeja("hija1")[0].de, "lider");
  assert.throws(() => recuperado.bandeja("ajeno"));
});

test("rechaza profundidad superior a dos, exceso de miembros y mensajes entre equipos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const equipos = await openTeams(dir);
  const a = await equipos.crear("a");
  const b = await equipos.crear("b");
  await equipos.agregar(a.id, "a", "a1", "codex");
  await equipos.agregar(a.id, "a1", "a2", "claude");
  await assert.rejects(
    equipos.agregar(a.id, "a2", "a3", "agy"),
    /profundidad/i,
  );
  await equipos.agregar(a.id, "a", "a4", "agy");
  await assert.rejects(equipos.agregar(a.id, "a", "a5", "agy"), /límite/i);
  await assert.rejects(equipos.mensaje("a", "b", "hola"));
  assert.notEqual(a.id, b.id);
});

test("encargos simultáneos no sobrepasan el límite y un miembro terminado libera cupo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inactivos = new Set();
  const equipos = await openTeams(dir, {
    activo: (id) => !inactivos.has(id),
  });
  const team = await equipos.crear("lider");
  const resultados = await Promise.allSettled(
    ["h1", "h2", "h3", "h4"].map((id) =>
      equipos.agregar(team.id, "lider", id, "codex"),
    ),
  );
  assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 3);
  inactivos.add("h1");
  await equipos.agregar(team.id, "lider", "h5", "agy");
  assert.equal(equipos.estado("lider").miembros.length, 5);
});
