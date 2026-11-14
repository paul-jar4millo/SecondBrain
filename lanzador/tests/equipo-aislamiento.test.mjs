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
import { abrirRegistro } from "../sesiones.mjs";
import { abrirEquipos } from "../equipos.mjs";
import { crearEjecutor } from "../ejecucion.mjs";
import { git, repoSintetico } from "./helpers-git.mjs";
import { manifiesto } from "./helpers-manifiesto.mjs";

const existe = (ruta) =>
  access(ruta).then(
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
const tarjeta = (id, motor) => ({
  id,
  motor,
  model: `modelo-${id}`,
  effort: "medium",
  role: `Rol ${id}`,
  responsibility: `Responsable ${id}`,
  coordinator: false,
  toolProfileId: "investigacion",
});

// Synthetic engines: a long-lived process the test cancels explicitly.
async function entorno(t, { proyecto, maxActivos = 6 } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sb-aisla-")));
  const datos = path.join(dir, "datos");
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setInterval(() => {}, 1000)");
  const registro = await abrirRegistro(path.join(dir, "sesiones.json"));
  const equipos = await abrirEquipos(path.join(dir, "equipos"), {
    activo: (id) =>
      registro
        .leer()
        .some(
          (s) => s.id === id && ["pendiente", "trabajando"].includes(s.estado),
        ),
  });
  const ejecutor = crearEjecutor({
    registro,
    equipos,
    maxActivos,
    env: { ...process.env, SB_LANZADOR_DATA_DIR: datos },
    proyectos: { prueba: proyecto ?? dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    registrar: () => {},
  });
  // Stops every synthetic process; Windows cannot delete a process's cwd.
  async function detener() {
    for (const s of registro.leer())
      if (["pendiente", "trabajando"].includes(s.estado))
        await ejecutor.cancelar(s.id).catch(() => {});
    await Promise.all(registro.leer().map((s) => ejecutor.esperar(s.id)));
  }
  t.after(async () => {
    await detener();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, datos, registro, equipos, ejecutor, detener };
}

test("la coordinadora del manifiesto crea hijas con su modelo, rol y workspace propio", async (t) => {
  const proyecto = await realpath(
    await mkdtemp(path.join(tmpdir(), "sb-aisla-proy-")),
  );
  t.after(() => rm(proyecto, { recursive: true, force: true }));
  await writeFile(path.join(proyecto, "brief.md"), "contexto\n");
  const { datos, registro, equipos, ejecutor, detener } = await entorno(t, {
    proyecto,
  });
  const mf = manifiesto([
    coordinadora,
    tarjeta("m-a", "codex"),
    tarjeta("m-b", "codex"),
  ]);
  const lider = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
    workOrderId: mf.workOrderId,
  });
  assert.equal(lider.memberId, "m-coord");
  assert.equal(lider.modelo, "modelo-coord");
  assert.equal(equipos.estado(lider.id).manifestSha256, mf.sha256);

  const a = await ejecutor.encargarHija(lider.id, {
    motor: "codex",
    brief: "parte A",
    memberId: "m-a",
  });
  const b = await ejecutor.encargarHija(lider.id, {
    motor: "codex",
    brief: "parte B",
  });
  for (const [hija, id] of [
    [a, "m-a"],
    [b, "m-b"],
  ]) {
    assert.equal(hija.memberId, id);
    assert.equal(hija.modelo, `modelo-${id}`);
    assert.equal(hija.esfuerzo, "medium");
    assert.equal(hija.role, `Rol ${id}`);
    assert.equal(hija.workspaceKind, "directory");
    assert.ok(
      hija.workspacePath.startsWith(path.join(datos, "member-workspaces")),
    );
    assert.equal(hija.directorio, hija.workspacePath);
    // Non-Git tasks get a private copy of the project inputs.
    assert.equal(
      await readFile(path.join(hija.workspacePath, "brief.md"), "utf8"),
      "contexto\n",
    );
  }
  assert.notEqual(a.workspacePath, b.workspacePath);
  await assert.rejects(
    ejecutor.encargarHija(lider.id, {
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

  await ejecutor.cancelar(a.id);
  await ejecutor.esperar(a.id);
  assert.ok(await existe(a.workspacePath), "se retiene tras terminar");
  await ejecutor.eliminar(a.id);
  assert.equal(await existe(a.workspacePath), false);
  assert.ok(registro.leer().some((s) => s.id === b.id));
  await detener();
});

test("en un repositorio cada hija trabaja en un worktree separado que se limpia al eliminarla", async (t) => {
  const repo = await repoSintetico(t);
  const { ejecutor, detener } = await entorno(t, { proyecto: repo });
  const mf = manifiesto([coordinadora, tarjeta("m-a", "agy")]);
  const lider = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  const hija = await ejecutor.encargarHija(lider.id, {
    motor: "agy",
    brief: "edita",
  });
  assert.equal(hija.workspaceKind, "git-worktree");
  assert.match(git(repo, "worktree", "list"), /member-workspaces/);
  await writeFile(path.join(hija.workspacePath, "a.txt"), "cambio aislado\n");
  assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "uno\n");

  await ejecutor.cancelar(hija.id);
  await ejecutor.esperar(hija.id);
  await ejecutor.eliminar(hija.id);
  assert.doesNotMatch(git(repo, "worktree", "list"), /member-workspaces/);
  assert.equal(await existe(hija.workspacePath), false);
  await detener();
});

test("sin cupo de procesos la hija queda en cola con motivo visible y arranca al liberarse", async (t) => {
  const { registro, ejecutor } = await entorno(t, { maxActivos: 2 });
  const mf = manifiesto([
    coordinadora,
    tarjeta("m-a", "codex"),
    tarjeta("m-b", "codex"),
    tarjeta("m-c", "codex"),
  ]);
  const lider = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  const a = await ejecutor.encargarHija(lider.id, {
    motor: "codex",
    brief: "a",
  });
  const b = await ejecutor.encargarHija(lider.id, {
    motor: "codex",
    brief: "b",
  });
  const c = await ejecutor.encargarHija(lider.id, {
    motor: "codex",
    brief: "c",
  });
  assert.equal(a.estado, "trabajando");
  for (const hija of [b, c]) {
    assert.equal(hija.estado, "pendiente");
    assert.equal(hija.enColaRecursos, true);
    assert.match(hija.motivoCola, /límite de procesos/);
  }
  assert.ok(b.enqueueOrder < c.enqueueOrder);
  assert.equal(ejecutor.activos(), 2);

  // Cancelling a queued member never starts it.
  await ejecutor.cancelar(c.id);
  assert.equal(registro.leer().find((s) => s.id === c.id).estado, "cancelada");

  await ejecutor.cancelar(a.id);
  await ejecutor.esperar(a.id);
  const despachada = registro.leer().find((s) => s.id === b.id);
  assert.equal(despachada.estado, "trabajando");
  assert.equal(despachada.enColaRecursos, false);
  assert.equal(ejecutor.activos(), 2);
  assert.equal(registro.leer().find((s) => s.id === c.id).estado, "cancelada");
});

test("una ruta de encargo no se autoriza a sí misma para facturar DeepSeek", async (t) => {
  const { ejecutor } = await entorno(t);
  const mf = manifiesto([coordinadora, tarjeta("m-d", "deepseek")]);
  const lider = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    manifest: mf,
  });
  await assert.rejects(
    ejecutor.encargarHija(lider.id, {
      motor: "deepseek",
      brief: "gasta",
      billingAuthorized: true,
    }),
    { status: 403, message: /gasto/ },
  );
});
