import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTeams } from "../teams.mjs";
import { manifiesto, sha } from "./helpers-manifest.mjs";

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
const tarjeta = (id, engine, extra = {}) => ({
  id,
  motor: engine,
  model: `modelo-${id}`,
  effort: "medium",
  role: `Rol ${id}`,
  responsibility: `Responsable ${id}`,
  coordinator: false,
  toolProfileId: "investigacion",
  ...extra,
});

async function almacen(t, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-mf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, equipos: await openTeams(dir, options) };
}

test("el manifiesto transporta modelo, esfuerzo y rol a cada hija, también con el mismo motor repetido", async (t) => {
  const { dir, equipos: teams } = await almacen(t);
  const mf = manifiesto([
    coordinadora,
    tarjeta("m-a", "codex"),
    tarjeta("m-b", "codex", { model: "otro", effort: "low" }),
    tarjeta("m-c", "agy"),
  ]);
  const team = await teams.crear("lider", { manifest: mf });
  const lead = team.miembros[0];
  assert.equal(lead.memberId, "m-coord");
  assert.equal(lead.modelo, "modelo-coord");
  assert.equal(team.manifestSha256, mf.sha256);

  const a = await teams.agregar(team.id, "lider", "h1", "codex", {
    memberId: "m-a",
  });
  // Without memberId the next free card of that engine is chosen.
  const b = await teams.agregar(team.id, "lider", "h2", "codex");
  const c = await teams.agregar(team.id, "lider", "h3", "agy", {
    memberId: "m-c",
  });
  assert.deepEqual(
    [a, b, c].map((m) => [m.memberId, m.modelo, m.esfuerzo, m.role]),
    [
      ["m-a", "modelo-m-a", "medium", "Rol m-a"],
      ["m-b", "otro", "low", "Rol m-b"],
      ["m-c", "modelo-m-c", "medium", "Rol m-c"],
    ],
  );
  const recuperado = await openTeams(dir);
  assert.equal(recuperado.estado("h2").miembros.length, 4);
  assert.equal(recuperado.estado("h2").manifestSha256, mf.sha256);
});

test("la coordinadora no cambia modelos, motores, perfiles ni añade integrantes fuera del manifiesto", async (t) => {
  const { equipos: teams } = await almacen(t);
  const mf = manifiesto([coordinadora, tarjeta("m-a", "codex")]);
  const team = await teams.crear("lider", { manifest: mf });
  const intento = (child, engine, meta) =>
    teams.agregar(team.id, "lider", child, engine, meta);

  await assert.rejects(
    intento("x1", "codex", { memberId: "m-a", modelo: "barato" }),
    {
      status: 409,
      message: /fija el modelo/,
    },
  );
  await assert.rejects(
    intento("x2", "codex", { memberId: "m-a", esfuerzo: "low" }),
    {
      status: 409,
      message: /fija el esfuerzo/,
    },
  );
  await assert.rejects(intento("x3", "agy", { memberId: "m-a" }), {
    status: 409,
    message: /motor/,
  });
  await assert.rejects(intento("x4", "codex", { memberId: "m-intrusa" }), {
    status: 403,
  });
  await assert.rejects(intento("x5", "agy"), { status: 403 });
  await assert.rejects(
    intento("x6", "codex", { memberId: "m-a", toolProfileId: "integracion" }),
    { status: 403, message: /ampliar el perfil/ },
  );
  await assert.rejects(
    intento("x7", "codex", { memberId: "m-a", manifestSha256: "f".repeat(64) }),
    { status: 409, message: /desactualizado/ },
  );
  assert.equal(teams.estado("lider").miembros.length, 1);

  await intento("h1", "codex", { memberId: "m-a" });
  await assert.rejects(intento("h2", "codex", { memberId: "m-a" }), {
    status: 409,
    message: /ya tiene una sesión activa/,
  });
});

test("equipos de una, dos y cuatro tarjetas respetan exactamente su tamaño", async (t) => {
  const { equipos: teams } = await almacen(t);
  const solo = await teams.crear("solo", {
    manifest: manifiesto([coordinadora]),
  });
  await assert.rejects(teams.agregar(solo.id, "solo", "s1", "codex"), {
    status: 403,
  });

  const dos = await teams.crear("dos", {
    manifest: manifiesto([coordinadora, tarjeta("m-a", "agy")]),
  });
  await teams.agregar(dos.id, "dos", "d1", "agy");
  await assert.rejects(
    teams.agregar(dos.id, "dos", "d2", "agy"),
    /límite|activas/i,
  );

  const cuatro = await teams.crear("cuatro", {
    manifest: manifiesto([
      coordinadora,
      tarjeta("m-1", "codex"),
      tarjeta("m-2", "codex"),
      tarjeta("m-3", "codex"),
    ]),
  });
  for (const child of ["c1", "c2", "c3"])
    await teams.agregar(cuatro.id, "cuatro", child, "codex");
  assert.deepEqual(
    teams
      .estado("cuatro")
      .miembros.slice(1)
      .map((m) => m.memberId),
    ["m-1", "m-2", "m-3"],
  );
  await assert.rejects(
    teams.agregar(cuatro.id, "cuatro", "c4", "codex"),
    /límite/i,
  );
});

test("un requestId repetido devuelve la misma integrante sin crear otra", async (t) => {
  const { equipos: teams } = await almacen(t);
  const team = await teams.crear("lider", {
    manifest: manifiesto([coordinadora, tarjeta("m-a", "codex")]),
  });
  const first = await teams.agregar(team.id, "lider", "h1", "codex", {
    requestId: "pedido-1",
  });
  const repetida = await teams.agregar(team.id, "lider", "h9", "codex", {
    requestId: "pedido-1",
  });
  assert.equal(repetida.id, first.id);
  assert.equal(repetida.repetido, true);
  assert.equal(teams.buscarPorRequestId("lider", "pedido-1").id, "h1");
  assert.equal(teams.estado("lider").miembros.length, 2);
});

test("sin manifiesto, una hija no amplía el perfil de su madre", async (t) => {
  const { equipos: teams } = await almacen(t);
  const team = await teams.crear("lider");
  await teams.actualizarMiembro("lider", { toolProfileId: "investigacion" });
  await assert.rejects(
    teams.agregar(team.id, "lider", "h1", "codex", {
      toolProfileId: "integracion",
    }),
    { status: 403 },
  );
  // Legacy calls without metadata keep working.
  await teams.agregar(team.id, "lider", "h2", "codex");
  await teams.entregar("h2", "Notas", "texto libre");
  assert.equal(teams.estado("lider").entregables[0].version, 1);
});

test("entregables versionados con hash e integración explícita de dos escritoras sin pisar archivos", async (t) => {
  const { equipos: teams } = await almacen(t);
  const target = await mkdtemp(path.join(tmpdir(), "sb-team-int-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(path.join(target, "comun.md"), "base\n");
  const equipo = await teams.crear("lider", {
    manifest: manifiesto([
      coordinadora,
      tarjeta("m-a", "codex"),
      tarjeta("m-b", "agy"),
    ]),
    directorioIntegracion: target,
  });
  await teams.agregar(equipo.id, "lider", "ha", "codex");
  await teams.agregar(equipo.id, "lider", "hb", "agy");

  const ea = await teams.entregar("ha", {
    titulo: "Parte A",
    archivos: [{ ruta: "docs/a.md", contenido: "A\n" }],
  });
  const eb = await teams.entregar("hb", {
    titulo: "Parte B",
    archivos: [{ ruta: "docs/b.md", contenido: "B\n" }],
  });
  assert.equal(ea.memberId, "m-a");
  assert.equal(ea.archivos[0].sha256, sha("A\n"));
  assert.notEqual(ea.sha256, eb.sha256);

  await assert.rejects(teams.integrar("ha"), { status: 403 });
  const result = await teams.integrar("lider");
  assert.equal(result.estado, "integrado");
  assert.deepEqual(result.integrados.map((i) => [i.ruta, i.miembro]).sort(), [
    ["docs/a.md", "m-a"],
    ["docs/b.md", "m-b"],
  ]);
  assert.equal(await readFile(path.join(target, "docs/a.md"), "utf8"), "A\n");
  assert.equal(await readFile(path.join(target, "docs/b.md"), "utf8"), "B\n");

  // A second version chained on the integrated hash integrates cleanly.
  const v2 = await teams.entregar("ha", {
    titulo: "Parte A",
    ruta: "docs/a.md",
    contenido: "A2\n",
    baseSha256: sha("A\n"),
  });
  assert.equal(v2.version, 1);
  const v3 = await teams.entregar("ha", {
    titulo: "Parte A",
    ruta: "docs/a.md",
    contenido: "A3\n",
    baseSha256: sha("A2\n"),
  });
  assert.equal(v3.version, 2);
  const encadenado = await teams.integrar("lider", {
    entregableIds: [v2.id, v3.id],
  });
  assert.equal(encadenado.estado, "integrado");
  assert.equal(await readFile(path.join(target, "docs/a.md"), "utf8"), "A3\n");
});

test("ediciones concurrentes del mismo archivo quedan como conflicto visible hasta una resolución explícita", async (t) => {
  const { equipos: teams } = await almacen(t);
  const target = await mkdtemp(path.join(tmpdir(), "sb-team-conf-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(path.join(target, "comun.md"), "base\n");
  const equipo = await teams.crear("lider", {
    manifest: manifiesto([
      coordinadora,
      tarjeta("m-a", "codex"),
      tarjeta("m-b", "agy"),
    ]),
    directorioIntegracion: target,
  });
  await teams.agregar(equipo.id, "lider", "ha", "codex");
  await teams.agregar(equipo.id, "lider", "hb", "agy");
  const base = sha("base\n");
  const ea = await teams.entregar("ha", {
    titulo: "A",
    ruta: "comun.md",
    contenido: "versión A\n",
    baseSha256: base,
  });
  const eb = await teams.entregar("hb", {
    titulo: "B",
    ruta: "comun.md",
    contenido: "versión B\n",
    baseSha256: base,
  });
  const conflict = await teams.integrar("lider");
  assert.equal(conflict.estado, "conflicto");
  assert.equal(conflict.conflictos[0].ruta, "comun.md");
  assert.deepEqual(
    conflict.conflictos[0].entregas.map((e) => e.memberId),
    ["m-a", "m-b"],
  );
  assert.equal(await readFile(path.join(target, "comun.md"), "utf8"), "base\n");
  assert.equal(teams.estado("lider").conflictos.length, 1);

  const resolved = await teams.integrar("lider", {
    resoluciones: [{ ruta: "comun.md", entregableId: eb.id }],
  });
  assert.equal(resolved.estado, "integrado");
  assert.equal(
    await readFile(path.join(target, "comun.md"), "utf8"),
    "versión B\n",
  );
  assert.ok(ea.id);
});

test("un cambio externo en el destino o una ruta fuera del workspace impide integrar", async (t) => {
  const { equipos: teams } = await almacen(t);
  const target = await mkdtemp(path.join(tmpdir(), "sb-team-ext-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(path.join(target, "nota.md"), "original\n");
  const equipo = await teams.crear("lider", {
    manifest: manifiesto([coordinadora, tarjeta("m-a", "codex")]),
    directorioIntegracion: target,
  });
  await teams.agregar(equipo.id, "lider", "ha", "codex");
  await teams.entregar("ha", {
    titulo: "Nota",
    ruta: "nota.md",
    contenido: "nuevo\n",
    baseSha256: sha("original\n"),
  });
  await writeFile(path.join(target, "nota.md"), "editado a mano\n");
  const result = await teams.integrar("lider");
  assert.equal(result.estado, "conflicto");
  assert.equal(result.conflictos[0].hashEnDisco, sha("editado a mano\n"));
  assert.equal(
    await readFile(path.join(target, "nota.md"), "utf8"),
    "editado a mano\n",
  );

  for (const ruta of ["../fuera.md", "C:/x.md", "/abs.md", ".git/config"])
    await assert.rejects(
      teams.entregar("ha", { titulo: "Mal", ruta, contenido: "x" }),
      /Ruta de entregable inválida/,
    );
});

test("un cambio manual posterior a una integración produce conflicto y ninguna resolución lo pisa sin verlo", async (t) => {
  const { equipos: teams } = await almacen(t);
  const target = await mkdtemp(path.join(tmpdir(), "sb-team-post-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const equipo = await teams.crear("lider", {
    manifest: manifiesto([coordinadora, tarjeta("m-a", "codex")]),
    directorioIntegracion: target,
  });
  await teams.agregar(equipo.id, "lider", "ha", "codex");
  const v1 = await teams.entregar("ha", {
    titulo: "Informe",
    ruta: "informe.md",
    contenido: "v1\n",
  });
  const first = await teams.integrar("lider");
  assert.equal(first.estado, "integrado");
  const archivo = path.join(target, "informe.md");
  assert.equal(await readFile(archivo, "utf8"), "v1\n");

  // The owner edits the integrated file by hand after the integration.
  await writeFile(archivo, "editado por Ana\n");
  const v2 = await teams.entregar("ha", {
    titulo: "Informe",
    ruta: "informe.md",
    contenido: "v2\n",
    baseSha256: sha("v1\n"),
  });

  // A resolution sent before any conflict was shown is rejected.
  await assert.rejects(
    teams.integrar("lider", {
      entregableIds: [v1.id, v2.id],
      resoluciones: [{ ruta: "informe.md", entregableId: v2.id }],
    }),
    { status: 409 },
  );
  assert.equal(await readFile(archivo, "utf8"), "editado por Ana\n");

  const conflicto = await teams.integrar("lider", {
    entregableIds: [v1.id, v2.id],
  });
  assert.equal(conflicto.estado, "conflicto");
  assert.equal(conflicto.conflictos[0].ruta, "informe.md");
  assert.equal(conflicto.conflictos[0].hashEnDisco, sha("editado por Ana\n"));
  assert.equal(await readFile(archivo, "utf8"), "editado por Ana\n");

  // Another manual edit after the conflict invalidates the old resolution.
  await writeFile(archivo, "segunda edición de Ana\n");
  const repeated = await teams.integrar("lider", {
    entregableIds: [v1.id, v2.id],
    resoluciones: [{ ruta: "informe.md", entregableId: v2.id }],
  });
  assert.equal(repeated.estado, "conflicto");
  assert.equal(
    repeated.conflictos[0].hashEnDisco,
    sha("segunda edición de Ana\n"),
  );
  assert.equal(await readFile(archivo, "utf8"), "segunda edición de Ana\n");

  // An explicit resolution over the destination the conflict showed applies
  // and records which on-disk version it replaced.
  const resolved = await teams.integrar("lider", {
    entregableIds: [v1.id, v2.id],
    resoluciones: [
      {
        ruta: "informe.md",
        contenido: "segunda edición de Ana\nv2\n",
      },
    ],
  });
  assert.equal(resolved.estado, "integrado");
  assert.equal(
    resolved.integrados[0].hashEnDiscoReemplazado,
    sha("segunda edición de Ana\n"),
  );
  assert.equal(await readFile(archivo, "utf8"), "segunda edición de Ana\nv2\n");
});
