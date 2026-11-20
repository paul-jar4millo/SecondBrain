import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSessionRegistry } from "../sessions.mjs";
import { openTeams } from "../teams.mjs";
import { createExecutor } from "../executor.mjs";
import { git, repoSintetico } from "./helpers-git.mjs";
import { manifiesto } from "./helpers-manifest.mjs";

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const coordinadora = {
  id: "m-coord",
  motor: "claude",
  model: "modelo-coord",
  effort: "high",
  role: "Coordinadora",
  responsibility: "Integra",
  coordinator: true,
  toolProfileId: "coordinacion",
};
const tarjeta = (id, engine) => ({
  id,
  motor: engine,
  model: `modelo-${id}`,
  effort: "medium",
  role: `Rol ${id}`,
  responsibility: `Responsable ${id}`,
  coordinator: false,
  toolProfileId: "investigacion",
});

// Synthetic engines: a long-lived process the test cancels explicitly.
async function environment(
  t,
  { proyecto: project, maxActivos: maxActive = 6 } = {},
) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sb-aisla-")));
  const data = path.join(dir, "datos");
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setInterval(() => {}, 1000)");
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
    maxActivos: maxActive,
    env: { ...process.env, SB_LANZADOR_DATA_DIR: data },
    proyectos: { prueba: project ?? dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    registrar: () => {},
  });
  // Stops every synthetic process; Windows cannot delete a process's cwd.
  async function stop() {
    for (const s of registry.leer())
      if (["pendiente", "trabajando"].includes(s.estado))
        await executor.cancelar(s.id).catch(() => {});
    await Promise.all(registry.leer().map((s) => executor.esperar(s.id)));
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    datos: data,
    registro: registry,
    equipos: teams,
    ejecutor: executor,
    detener: stop,
  };
}

test("la coordinadora del manifiesto crea hijas con su modelo, rol y workspace propio", async (t) => {
  const proyecto = await realpath(
    await mkdtemp(path.join(tmpdir(), "sb-aisla-proy-")),
  );
  t.after(() => rm(proyecto, { recursive: true, force: true }));
  await writeFile(path.join(proyecto, "brief.md"), "contexto\n");
  const {
    datos: data,
    registro: registry,
    equipos: teams,
    ejecutor: executor,
    detener: stop,
  } = await environment(t, {
    proyecto,
  });
  const mf = manifiesto([
    coordinadora,
    tarjeta("m-a", "codex"),
    tarjeta("m-b", "codex"),
  ]);
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
    workOrderId: mf.workOrderId,
  });
  assert.equal(lead.memberId, "m-coord");
  assert.equal(lead.modelo, "modelo-coord");
  assert.equal(teams.estado(lead.id).manifestSha256, mf.sha256);

  const a = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "parte A",
    memberId: "m-a",
  });
  const b = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "parte B",
  });
  for (const [child, id] of [
    [a, "m-a"],
    [b, "m-b"],
  ]) {
    assert.equal(child.memberId, id);
    assert.equal(child.modelo, `modelo-${id}`);
    assert.equal(child.esfuerzo, "medium");
    assert.equal(child.role, `Rol ${id}`);
    assert.equal(child.workspaceKind, "directory");
    assert.ok(
      child.workspacePath.startsWith(path.join(data, "member-workspaces")),
    );
    assert.equal(child.directorio, child.workspacePath);
    // Non-Git tasks get a private copy of the project inputs.
    assert.equal(
      await readFile(path.join(child.workspacePath, "brief.md"), "utf8"),
      "contexto\n",
    );
  }
  assert.notEqual(a.workspacePath, b.workspacePath);
  await assert.rejects(
    executor.encargarHija(lead.id, {
      motor: "codex",
      brief: "cambia",
      memberId: "m-a",
      modelo: "barato",
    }),
    { status: 409 },
  );
  // Neither writer touched the shared project.
  await writeFile(path.join(a.workspacePath, "brief.md"), "editado por A\n");
  assert.equal(
    await readFile(path.join(proyecto, "brief.md"), "utf8"),
    "contexto\n",
  );

  await executor.cancelar(a.id);
  await executor.esperar(a.id);
  assert.ok(await exists(a.workspacePath), "se retiene tras terminar");
  await executor.eliminar(a.id);
  assert.equal(await exists(a.workspacePath), false);
  assert.ok(registry.leer().some((s) => s.id === b.id));
  await stop();
});

test("en un repositorio cada hija trabaja en un worktree separado que se limpia al eliminarla", async (t) => {
  const repo = await repoSintetico(t);
  const { ejecutor: executor, detener: stop } = await environment(t, {
    proyecto: repo,
  });
  const mf = manifiesto([coordinadora, tarjeta("m-a", "agy")]);
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  const child = await executor.encargarHija(lead.id, {
    motor: "agy",
    brief: "edita",
  });
  assert.equal(child.workspaceKind, "git-worktree");
  assert.match(git(repo, "worktree", "list"), /member-workspaces/);
  await writeFile(path.join(child.workspacePath, "a.txt"), "cambio aislado\n");
  assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "uno\n");

  await executor.cancelar(child.id);
  await executor.esperar(child.id);
  await executor.eliminar(child.id);
  assert.doesNotMatch(git(repo, "worktree", "list"), /member-workspaces/);
  assert.equal(await exists(child.workspacePath), false);
  await stop();
});

test("sin cupo de procesos la hija queda en cola con motivo visible y arranca al liberarse", async (t) => {
  const { registro: registry, ejecutor: executor } = await environment(t, {
    maxActivos: 2,
  });
  const mf = manifiesto([
    coordinadora,
    tarjeta("m-a", "codex"),
    tarjeta("m-b", "codex"),
    tarjeta("m-c", "codex"),
  ]);
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  const a = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "a",
  });
  const b = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "b",
  });
  const c = await executor.encargarHija(lead.id, {
    motor: "codex",
    brief: "c",
  });
  assert.equal(a.estado, "trabajando");
  for (const child of [b, c]) {
    assert.equal(child.estado, "pendiente");
    assert.equal(child.enColaRecursos, true);
    assert.match(child.motivoCola, /límite de procesos/);
  }
  assert.ok(b.enqueueOrder < c.enqueueOrder);
  assert.equal(executor.activos(), 2);

  // Cancelling a queued member never starts it.
  await executor.cancelar(c.id);
  assert.equal(registry.leer().find((s) => s.id === c.id).estado, "cancelada");

  await executor.cancelar(a.id);
  await executor.esperar(a.id);
  const despachada = registry.leer().find((s) => s.id === b.id);
  assert.equal(despachada.estado, "trabajando");
  assert.equal(despachada.enColaRecursos, false);
  assert.equal(executor.activos(), 2);
  assert.equal(registry.leer().find((s) => s.id === c.id).estado, "cancelada");
});

test("una ruta de encargo no se autoriza a sí misma para facturar DeepSeek", async (t) => {
  const { ejecutor: executor } = await environment(t);
  const mf = manifiesto([coordinadora, tarjeta("m-d", "deepseek")]);
  const lead = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  await assert.rejects(
    executor.encargarHija(lead.id, {
      motor: "deepseek",
      brief: "gasta",
      billingAuthorized: true,
    }),
    { status: 403, message: /gasto/ },
  );
});
