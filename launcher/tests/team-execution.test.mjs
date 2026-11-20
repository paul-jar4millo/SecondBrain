import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSessionRegistry } from "../sessions.mjs";
import { openTeams } from "../teams.mjs";
import { createExecutor } from "../executor.mjs";
import { openWorkspaces } from "../workspaces.mjs";

test("a project without a repository shares its original workspace with delegated sessions", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-project-team-"));
  await mkdir(path.join(dir, ".git"));
  const registry = await openSessionRegistry(path.join(dir, "sessions.json"));
  const equipos = await openTeams(path.join(dir, "teams"), {
    activo: (id) =>
      registry.leer().some((s) => s.id === id && s.estado === "trabajando"),
  });
  const espacios = await openWorkspaces({
    archivo: path.join(dir, "spaces.json"),
    proyectos: { repo: dir },
    workspaces: path.join(dir, "workspaces"),
  });
  const runner = createExecutor({
    registro: registry,
    equipos,
    espacios,
    proyectos: { repo: dir },
    comando: (engine) => ({
      bin: process.execPath,
      args: [
        "-e",
        engine === "claude"
          ? "setInterval(()=>{},1000)"
          : 'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:process.cwd()}}))',
      ],
    }),
  });
  const parent = await runner.encargar({
    motor: "claude",
    origen: "sala",
    espacioId: "p1",
    brief: "coordina",
  });
  t.after(async () => {
    if (runner.activos()) await runner.cancelar(parent.id);
    await runner.esperar(parent.id);
    await rm(dir, { recursive: true, force: true });
  });
  await espacios.vincular({ id: "p1", repositorio: "repo", revision: 0 });
  const child = await runner.encargarHija(parent.id, {
    motor: "codex",
    brief: "revisa",
  });
  await runner.esperar(child.id);
  assert.equal(child.espacioId, "p1");
  assert.equal(child.directorio, parent.directorio);
  assert.equal(
    registry.leer().find((s) => s.id === child.id).resultado,
    parent.directorio,
  );
});

test("un líder encarga hijas de otros motores y respeta el límite antes de arrancarlas", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-ejecutar-equipo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setTimeout(() => {}, 3000)");
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const teams = await openTeams(path.join(dir, "equipos"), {
    activo: (id) =>
      registry
        .leer()
        .some(
          (s) => s.id === id && ["pendiente", "trabajando"].includes(s.estado),
        ),
  });
  const executor = createExecutor({
    registro: registry,
    equipos: teams,
    proyectos: { prueba: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    consultarSaldo: async () => 0.19,
  });
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
  });
  await assert.rejects(
    executor.encargarHija(lead.id, { motor: "deepseek", brief: "revisa" }),
    /saldo/i,
  );
  const hijas = await Promise.all(
    ["claude", "agy", "codex"].map((engine) =>
      executor.encargarHija(lead.id, { motor: engine, brief: "trabaja" }),
    ),
  );
  assert.equal(teams.estado(lead.id).miembros.length, 4);
  assert.ok(hijas.every((h) => h.padreId === lead.id));
  assert.equal(executor.activos(), 4);
  await assert.rejects(
    executor.encargarHija(lead.id, { motor: "agy", brief: "extra" }),
    /límite/i,
  );
  assert.equal(executor.activos(), 4);
  for (const id of [lead.id, ...hijas.map((h) => h.id)])
    await executor.cancelar(id);
  await Promise.all(
    [lead.id, ...hijas.map((h) => h.id)].map((id) => executor.esperar(id)),
  );
});

test("el padre puede esperar el resultado de su hija o recibir pendiente", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-wait-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake.mjs");
  await writeFile(
    fake,
    'setTimeout(() => console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"hecho"}})), 150)',
  );
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const teams = await openTeams(path.join(dir, "equipos"), {
    activo: (id) =>
      registry
        .leer()
        .some(
          (s) => s.id === id && ["pendiente", "trabajando"].includes(s.estado),
        ),
  });
  const executor = createExecutor({
    registro: registry,
    equipos: teams,
    proyectos: { prueba: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
  });
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
  });
  const child = await executor
    .encargarHija(lead.id, { motor: "deepseek", brief: "revisa" })
    .catch(() => null);
  assert.equal(child, null);
  const hija2 = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "revisa",
  });
  assert.equal(
    (await executor.esperarHija(lead.id, hija2.id, 1)).estado,
    "pendiente",
  );
  const result = await executor.esperarHija(lead.id, hija2.id, 3000);
  assert.equal(result.estado, "terminada");
  assert.equal(result.resultado, "hecho");
  await executor.esperar(lead.id);
});
