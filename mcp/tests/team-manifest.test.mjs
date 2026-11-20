import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcp } from "../index.mjs";
import { createApplication } from "../../service/index.mjs";
import { openSessionRegistry } from "../../launcher/sessions.mjs";
import { openTeams } from "../../launcher/teams.mjs";
import { createExecutor } from "../../launcher/executor.mjs";
import { createLauncherServer } from "../../launcher/index.mjs";

const carta = (id, characterId, engine, model, coordinator = false) => ({
  id,
  characterId,
  engine,
  model,
  effort: "medium",
  role: `Rol ${id}`,
  responsibility: `Responsabilidad ${id}`,
  coordinator,
  toolProfileId: coordinator ? "coordinacion" : "investigacion",
});

test("un encargo de cuatro tarjetas delega por manifiesto, repite motor y se integra sin pisar archivos", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mf-e2e-")));
  const project = path.join(dir, "proyecto");
  await mkdir(project, { recursive: true });
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setInterval(() => {}, 1000)");
  const registry = await openSessionRegistry(
    path.join(dir, "state", "sesiones.json"),
  );
  const teams = await openTeams(path.join(dir, "state", "equipos"), {
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
    env: { ...process.env, SB_LANZADOR_DATA_DIR: path.join(dir, "datos") },
    proyectos: { prueba: project },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    registrar: () => {},
  });
  const validados = [];
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const launcher = createLauncherServer({
    registro: registry,
    equipos: teams,
    ejecutor: executor,
    controlHash: hash("control"),
    hookHash: hash("hook"),
    // Synthetic catalog: records what the launcher checked before starting.
    catalogo: {
      validar: async (engine, model, effort) => {
        validados.push([engine, model ?? null, effort ?? null]);
      },
    },
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "app"),
    auth: false,
    agentes: { brainToken: "room" },
    lanzador: {
      url: `http://127.0.0.1:${launcher.address().port}`,
      token: "control",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const clientes = [];
  t.after(async () => {
    for (const c of clientes) await c.close();
    for (const s of registry.leer())
      if (["pendiente", "trabajando"].includes(s.estado))
        await executor.cancelar(s.id).catch(() => {});
    await Promise.all(registry.leer().map((s) => executor.esperar(s.id)));
    await app.close();
    await new Promise((resolve) => launcher.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const csrf = await fetch(`${base}/auth/csrf`);
  const { token } = await csrf.json();
  const usuario = {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  const request = async (path, cuerpo) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: usuario,
      body: JSON.stringify(cuerpo),
    });
    const data = await r.json();
    assert.ok(r.ok, JSON.stringify(data));
    return data;
  };
  const { encargo: task } = await request("/encargos", {
    title: "Cuatro tarjetas",
    objective: "Delegar respetando el manifiesto",
    acceptanceCriteria: [{ id: "c1", text: "Modelos elegidos" }],
    team: [
      carta("coord", "ambar", "claude", "modelo-coord", true),
      carta("menta-1", "menta", "codex", "modelo-a"),
      carta("menta-2", "menta", "codex", "modelo-b"),
      carta("lira-1", "lira", "agy", "modelo-c"),
    ],
  });
  await request("/encargos/iniciar", { workOrderId: task.id });
  const lead = await request("/agentes/sesiones", {
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
    workOrderId: task.id,
    memberId: "coord",
  });
  assert.equal(lead.memberId, "coord");
  assert.equal(lead.modelo, "modelo-coord");

  async function cliente(actor, sessionId) {
    const server = createBrainMcp({
      baseUrl: base,
      token: "room",
      actor,
      sessionId,
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    clientes.push(client);
    return client;
  }
  const llamar = async (client, name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, datos: r.content?.[0]?.text };
  };
  const exito = async (client, name, args) => {
    const r = await llamar(client, name, args);
    assert.equal(r.error, false, r.datos);
    return JSON.parse(r.datos);
  };

  const ambar = await cliente("ambar", lead.id);
  const herramientas = await ambar.listTools();
  const delegate = herramientas.tools.find((h) => h.name === "equipo_encargar");
  assert.equal(delegate.inputSchema.properties.billingAuthorized, undefined);
  assert.ok(herramientas.tools.some((h) => h.name === "equipo_integrar"));

  // Same engine twice: each card keeps its own model.
  const h1 = await exito(ambar, "equipo_encargar", {
    motor: "codex",
    brief: "A",
  });
  const h2 = await exito(ambar, "equipo_encargar", {
    motor: "codex",
    brief: "B",
    requestId: "pedido-b",
  });
  const repetida = await exito(ambar, "equipo_encargar", {
    motor: "codex",
    brief: "B",
    requestId: "pedido-b",
  });
  assert.equal(repetida.id, h2.id);
  const h3 = await exito(ambar, "equipo_encargar", {
    motor: "agy",
    brief: "C",
  });
  assert.deepEqual(
    [h1, h2, h3].map((h) => [h.memberId, h.modelo]),
    [
      ["menta-1", "modelo-a"],
      ["menta-2", "modelo-b"],
      ["lira-1", "modelo-c"],
    ],
  );
  assert.equal(new Set([h1, h2, h3].map((h) => h.workspacePath)).size, 3);
  assert.ok(
    validados.some(([m, model]) => m === "claude" && model === "modelo-coord"),
  );

  // The leader cannot add a fifth member nor swap a model.
  assert.equal(
    (await llamar(ambar, "equipo_encargar", { motor: "codex", brief: "D" }))
      .error,
    true,
  );
  assert.match(
    (
      await llamar(ambar, "equipo_encargar", {
        motor: "agy",
        brief: "E",
        memberId: "lira-1",
        modelo: "otro",
      })
    ).datos,
    /fija el modelo|sesión activa/,
  );

  const menta1 = await cliente("menta", h1.id);
  const menta2 = await cliente("menta", h2.id);
  await exito(menta1, "equipo_entregar", {
    titulo: "Parte A",
    archivos: [{ ruta: "salida/a.md", contenido: "A\n" }],
  });
  await exito(menta2, "equipo_entregar", {
    titulo: "Parte B",
    archivos: [{ ruta: "salida/b.md", contenido: "B\n" }],
  });
  // Only the coordinator integrates.
  assert.equal((await llamar(menta1, "equipo_integrar")).error, true);
  const integrated = await exito(ambar, "equipo_integrar");
  assert.equal(integrated.estado, "integrado");
  assert.equal(
    await readFile(path.join(project, "salida/a.md"), "utf8"),
    "A\n",
  );
  assert.equal(
    await readFile(path.join(project, "salida/b.md"), "utf8"),
    "B\n",
  );

  const detail = await fetch(
    `${base}/encargos/detalle?id=${task.id}&cursor=0`,
    { headers: usuario },
  );
  const texto = JSON.stringify(await detail.json());
  for (const id of ["menta-1", "menta-2", "lira-1"])
    assert.match(texto, new RegExp(id));
  assert.match(texto, /artifact\.published/);
  assert.match(texto, /integration_completed/);
});
