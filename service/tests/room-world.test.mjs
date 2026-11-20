import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";
import { createRoom } from "../room.mjs";

process.env.SB_REFERENCE_BANK = fileURLToPath(
  new URL("./fixtures/reference-bank.json", import.meta.url),
);

async function start(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-sala-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Vault de prueba\n");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(root, "data"),
    auth: false,
    ...options(root),
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
  const post = (path, cuerpo) =>
    fetch(base + path, {
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
  const data = {
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
  await writeFile(path.join(dir, "paquete.json"), JSON.stringify(data));
  return { dir, datos: data };
}

test("sala: banco, tablero persistente y proxy limitado al banco", async (t) => {
  const { base, post } = await start(t, () => ({}));
  const room = await (await fetch(base + "/sala")).json();
  assert.ok(room.pines.length > 0);
  assert.deepEqual(room.tablero, []);
  const id = room.pines[0].id;
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
  const { base, post } = await start(t, () => ({}));
  const read = async (e) => (await fetch(`${base}/sala?espacio=${e}`)).json();
  const { pines } = await read("general");
  const id = pines[0].id;
  await post("/sala/tablero", { id, guardar: true, espacio: "proyecto-1" });
  assert.deepEqual((await read("proyecto-1")).tablero, [id]);
  assert.deepEqual((await read("proyecto-2")).tablero, []);
  assert.deepEqual((await read("general")).tablero, []);
  assert.equal(
    (await fetch(`${base}/sala?espacio=${encodeURIComponent("../x")}`)).status,
    400,
  );

  const created = {
    nombre: " Coral ",
    tipo: "gemini",
    espacio: "proyecto-1",
    colores: { pelo: "#FF0000" },
  };
  const creada = await post("/sala/agentes", created);
  assert.equal(creada.status, 410);
  assert.equal((await read("proyecto-1")).agentes.length, 0);
  assert.equal((await read("proyecto-2")).agentes.length, 0);
  assert.equal((await read("general")).resumen["proyecto-1"].agentes, 0);

  for (const mala of [
    { ...created, nombre: "  " },
    { ...created, nombre: "x".repeat(25) },
    { ...created, tipo: "otro" },
    { ...created, colores: { pelo: "red" } },
    { ...created, espacio: "a/b" },
  ])
    assert.equal((await post("/sala/agentes", mala)).status, 410);
});

test("sala: orders are limited to four agents, survive restart and keep other assignments", async (t) => {
  const { base, post, root } = await start(t, () => ({}));
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
  const reloaded = await createRoom(path.join(root, "data"), Error);
  assert.equal(reloaded.leer().encargos.marina.project, "p1");
});

test("sala: simultaneous orders persist without sharing temporary-file renames", async (t) => {
  const { post, root } = await start(t, () => ({}));
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
  const reloaded = await createRoom(path.join(root, "data"), Error);
  assert.equal(Object.keys(reloaded.leer().encargos).length, 4);
});

test("sala: el tablero del formato anterior pasa a la sala general", async (t) => {
  const { base } = await start(t, (root) => ({
    dataDirectory: path.join(root, "viejo"),
  }));
  assert.deepEqual((await (await fetch(base + "/sala")).json()).tablero, []);
  const root = await mkdtemp(path.join(tmpdir(), "sb-sala-viejo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bank = (await (await fetch(base + "/sala")).json()).pines[0].id;
  await writeFile(
    path.join(root, "sala.json"),
    JSON.stringify({ tablero: [bank] }),
  );
  const room = await createRoom(root, Error);
  assert.deepEqual(room.leer().tablero, [bank]);
  assert.deepEqual(room.leer("otro").tablero, []);
});

test("mundo: sin paquete avisa cómo publicarlo", async (t) => {
  const { base } = await start(t, () => ({}));
  const r = await fetch(base + "/mundo/overview");
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /publicar:panel/);
});

test("mundo: rechaza un paquete de otro formato", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { dir, datos: data } = await paquete(folder);
  await writeFile(
    path.join(dir, "paquete.json"),
    JSON.stringify({ ...data, formato: 2 }),
  );
  const { base } = await start(t, () => ({ mundoPaquete: dir }));
  const r = await fetch(base + "/mundo/overview");
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /formato/);
});

test("mundo: sirve solo el paquete y no ejecuta nada", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { dir } = await paquete(folder);
  const { base, post } = await start(t, () => ({ mundoPaquete: dir }));
  const data = await (await fetch(base + "/mundo/overview")).json();
  assert.equal(data.scannedAt, "2026-11-06T00:00:00.000Z");
  assert.match(data.videos[0].poster, /^\/api\/v1\/mundo\/media\?path=/);
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
  const folder = await mkdtemp(path.join(tmpdir(), "sb-canal-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { dir } = await paquete(folder);
  const { base, post } = await start(t, () => ({ mundoPaquete: dir }));
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
  const task = await post("/mundo/tasks", {
    agentId: "analista",
    instruction: "x",
  });
  assert.equal(task.status, 201);
  const { id } = await task.json();
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
