import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";
import { createSala } from "../room.mjs";

process.env.SB_REFERENCE_BANK = fileURLToPath(
  new URL("./fixtures/reference-bank.json", import.meta.url),
);

async function iniciar(t, opciones = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-sala-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Vault de prueba\n");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(root, "data"),
    auth: false,
    ...opciones(root),
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const csrf = await fetch(base + "/auth/csrf");
  const { token } = await csrf.json();
  const cookie = csrf.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const post = (ruta, cuerpo) =>
    fetch(base + ruta, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token,
        Origin: new URL(base).origin,
        Cookie: cookie,
      },
      body: JSON.stringify(cuerpo),
    });
  return { base, post, root };
}
async function paquete(root) {
  const dir = path.join(root, "paquete");
  await mkdir(path.join(dir, "archivos/canal/videos/v1"), { recursive: true });
  await writeFile(path.join(root, "secreto.md"), "no servir");
  await writeFile(
    path.join(dir, "archivos/canal/videos/v1/beats.md"),
    "# Beats",
  );
  await writeFile(
    path.join(dir, "archivos/canal/videos/v1/portada.png"),
    "png",
  );
  await writeFile(path.join(dir, "archivos/canal/videos/v1/nota.txt"), "txt");
  const datos = {
    formato: 1,
    generado: "2026-11-06T00:00:00.000Z",
    videos: [
      {
        id: "canal/videos/v1",
        poster: "canal/videos/v1/portada.png",
        files: ["beats.md"],
      },
    ],
    agents: [
      { id: "analista", name: "Analista", description: "", source: "x.md" },
    ],
  };
  await writeFile(path.join(dir, "paquete.json"), JSON.stringify(datos));
  return { dir, datos };
}

test("sala: banco, tablero persistente y proxy limitado al banco", async (t) => {
  const { base, post } = await iniciar(t, () => ({}));
  const sala = await (await fetch(base + "/sala")).json();
  assert.ok(sala.pines.length > 0);
  assert.deepEqual(sala.tablero, []);
  const id = sala.pines[0].id;
  assert.equal(
    (await post("/sala/tablero", { id: "x", guardar: true })).status,
    404,
  );
  assert.deepEqual(
    await (await post("/sala/tablero", { id, guardar: true })).json(),
    [id],
  );
  assert.deepEqual(
    await (await post("/sala/tablero", { id, guardar: false })).json(),
    [],
  );
  const ajena = await fetch(
    base + "/sala/imagen?id=" + encodeURIComponent("https://example.com/x.jpg"),
  );
  assert.equal(ajena.status, 404);
});

test("sala: cada proyecto conserva su tablero y no permite agentes adicionales", async (t) => {
  const { base, post } = await iniciar(t, () => ({}));
  const leer = async (e) => (await fetch(`${base}/sala?espacio=${e}`)).json();
  const { pines } = await leer("general");
  const id = pines[0].id;
  await post("/sala/tablero", { id, guardar: true, espacio: "proyecto-1" });
  assert.deepEqual((await leer("proyecto-1")).tablero, [id]);
  assert.deepEqual((await leer("proyecto-2")).tablero, []);
  assert.deepEqual((await leer("general")).tablero, []);
  assert.equal(
    (await fetch(`${base}/sala?espacio=${encodeURIComponent("../x")}`)).status,
    400,
  );

  const nueva = {
    nombre: " Coral ",
    tipo: "gemini",
    espacio: "proyecto-1",
    colores: { pelo: "#FF0000" },
  };
  const creada = await post("/sala/agentes", nueva);
  assert.equal(creada.status, 410);
  assert.equal((await leer("proyecto-1")).agentes.length, 0);
  assert.equal((await leer("proyecto-2")).agentes.length, 0);
  assert.equal((await leer("general")).resumen["proyecto-1"].agentes, 0);

  for (const mala of [
    { ...nueva, nombre: "  " },
    { ...nueva, nombre: "x".repeat(25) },
    { ...nueva, tipo: "otro" },
    { ...nueva, colores: { pelo: "red" } },
    { ...nueva, espacio: "a/b" },
  ])
    assert.equal((await post("/sala/agentes", mala)).status, 410);
});

test("sala: orders are limited to four agents, survive restart and keep other assignments", async (t) => {
  const { base, post, root } = await iniciar(t, () => ({}));
  const order = {
    id: "marina",
    mode: "work",
    instruction: "  Revisar código en el taller  ",
    project: "p1",
  };
  assert.equal(
    (await post("/sala/encargos", { ...order, id: "custom" })).status,
    400,
  );
  assert.equal(
    (await post("/sala/encargos", { ...order, instruction: "" })).status,
    400,
  );
  assert.equal((await post("/sala/encargos", order)).status, 200);
  await post("/sala/encargos", { id: "ambar", mode: "rest" });
  const data = await (await fetch(base + "/sala")).json();
  assert.equal(data.encargos.marina.project, "p1");
  assert.equal(data.encargos.marina.instruction, "Revisar código en el taller");
  assert.equal(data.encargos.ambar.mode, "rest");
  const reloaded = await createSala(path.join(root, "data"), Error);
  assert.equal(reloaded.leer().encargos.marina.project, "p1");
});

test("sala: simultaneous orders persist without sharing temporary-file renames", async (t) => {
  const { post, root } = await iniciar(t, () => ({}));
  const responses = await Promise.all(
    ["ambar", "menta", "lira", "marina"].map((id) =>
      post("/sala/encargos", {
        id,
        mode: "work",
        instruction: "Investiga",
        project: id,
      }),
    ),
  );
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200, 200],
  );
  const reloaded = await createSala(path.join(root, "data"), Error);
  assert.equal(Object.keys(reloaded.leer().encargos).length, 4);
});

test("sala: el tablero del formato anterior pasa a la sala general", async (t) => {
  const { base } = await iniciar(t, (root) => ({
    dataDirectory: path.join(root, "viejo"),
  }));
  assert.deepEqual((await (await fetch(base + "/sala")).json()).tablero, []);
  const root = await mkdtemp(path.join(tmpdir(), "sb-sala-viejo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const banco = (await (await fetch(base + "/sala")).json()).pines[0].id;
  await writeFile(
    path.join(root, "sala.json"),
    JSON.stringify({ tablero: [banco] }),
  );
  const sala = await createSala(root, Error);
  assert.deepEqual(sala.leer().tablero, [banco]);
  assert.deepEqual(sala.leer("otro").tablero, []);
});

test("mundo: sin paquete avisa cómo publicarlo", async (t) => {
  const { base } = await iniciar(t, () => ({}));
  const r = await fetch(base + "/mundo/overview");
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /publicar:panel/);
});

test("mundo: rechaza un paquete de otro formato", async (t) => {
  const carpeta = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(carpeta, { recursive: true, force: true }));
  const { dir, datos } = await paquete(carpeta);
  await writeFile(
    path.join(dir, "paquete.json"),
    JSON.stringify({ ...datos, formato: 2 }),
  );
  const { base } = await iniciar(t, () => ({ mundoPaquete: dir }));
  const r = await fetch(base + "/mundo/overview");
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /formato/);
});

test("mundo: sirve solo el paquete y no ejecuta nada", async (t) => {
  const carpeta = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(carpeta, { recursive: true, force: true }));
  const { dir } = await paquete(carpeta);
  const { base, post } = await iniciar(t, () => ({ mundoPaquete: dir }));
  const datos = await (await fetch(base + "/mundo/overview")).json();
  assert.equal(datos.scannedAt, "2026-11-06T00:00:00.000Z");
  assert.match(datos.videos[0].poster, /^\/api\/v1\/mundo\/media\?path=/);
  const ruta = (p) => encodeURIComponent(p);
  const imagen = await fetch(
    base + "/mundo/media?path=" + ruta("canal/videos/v1/portada.png"),
  );
  assert.equal(imagen.status, 200);
  assert.equal(imagen.headers.get("content-type"), "image/png");
  const doc = await fetch(
    base + "/mundo/document?path=" + ruta("canal/videos/v1/beats.md"),
  );
  assert.equal((await doc.json()).text, "# Beats");
  for (const fuera of ["../../secreto.md", "../paquete.json"])
    assert.notEqual(
      (await fetch(base + "/mundo/document?path=" + ruta(fuera))).status,
      200,
    );
  const txt = await fetch(
    base + "/mundo/document?path=" + ruta("canal/videos/v1/nota.txt"),
  );
  assert.equal(txt.status, 403);
  assert.equal((await post("/mundo/jobs", { kind: "metrics" })).status, 404);
});

test("mundo: briefs, encargos y notas persisten fuera del paquete", async (t) => {
  const carpeta = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(carpeta, { recursive: true, force: true }));
  const { dir } = await paquete(carpeta);
  const { base, post } = await iniciar(t, () => ({ mundoPaquete: dir }));
  const brief = await post("/mundo/briefs", {
    title: "T",
    brief: "B",
    slug: "tema",
  });
  assert.equal(brief.status, 201);
  assert.equal(
    (await post("/mundo/briefs", { title: "T", brief: "B", slug: "Mal Tema" }))
      .status,
    400,
  );
  assert.equal(
    (
      await post("/mundo/agents", {
        id: "analista",
        enabled: false,
        notes: "n",
      })
    ).status,
    200,
  );
  assert.equal(
    (await post("/mundo/tasks", { agentId: "analista", instruction: "x" }))
      .status,
    409,
  );
  await post("/mundo/agents", { id: "analista", enabled: true, notes: "n" });
  const encargo = await post("/mundo/tasks", {
    agentId: "analista",
    instruction: "x",
  });
  assert.equal(encargo.status, 201);
  const { id } = await encargo.json();
  assert.equal(
    (await post("/mundo/tasks/status", { id, status: "completed" })).status,
    200,
  );
  const { state, agents } = await (
    await fetch(base + "/mundo/overview")
  ).json();
  assert.equal(state.briefs.length, 1);
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(agents[0].notes, "n");
});
