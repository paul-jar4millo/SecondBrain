import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTeams } from "../teams.mjs";

test("miembros intercambian mensajes y entregables, conservados tras reiniciar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const teams = await openTeams(dir);
  const equipo = await teams.crear("lider");
  await teams.agregar(equipo.id, "lider", "hija1", "agy");
  await teams.agregar(equipo.id, "lider", "hija2", "deepseek");
  await teams.mensaje("lider", "hija1", "Busca X");
  await teams.entregar("hija1", "Hallazgos", "Resultado sintético");
  assert.equal(teams.bandeja("hija1")[0].texto, "Busca X");
  assert.equal(
    teams.estado("lider").entregables[0].contenido,
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
  const teams = await openTeams(dir);
  const a = await teams.crear("a");
  const b = await teams.crear("b");
  await teams.agregar(a.id, "a", "a1", "codex");
  await teams.agregar(a.id, "a1", "a2", "claude");
  await assert.rejects(teams.agregar(a.id, "a2", "a3", "agy"), /profundidad/i);
  await teams.agregar(a.id, "a", "a4", "agy");
  await assert.rejects(teams.agregar(a.id, "a", "a5", "agy"), /límite/i);
  await assert.rejects(teams.mensaje("a", "b", "hola"));
  assert.notEqual(a.id, b.id);
});

test("encargos simultáneos no sobrepasan el límite y un miembro terminado libera cupo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inactivos = new Set();
  const teams = await openTeams(dir, {
    activo: (id) => !inactivos.has(id),
  });
  const team = await teams.crear("lider");
  const results = await Promise.allSettled(
    ["h1", "h2", "h3", "h4"].map((id) =>
      teams.agregar(team.id, "lider", id, "codex"),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  inactivos.add("h1");
  await teams.agregar(team.id, "lider", "h5", "agy");
  assert.equal(teams.estado("lider").miembros.length, 5);
});
