import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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

test("MCP, servicio y lanzador coordinan sesiones de distintos motores", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-team-e2e-"));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");
  const fake = path.join(dir, "fake.mjs");
  await writeFile(
    fake,
    'setTimeout(() => { console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"listo"}})); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"listo"}})); }, Number(process.argv[2]))',
  );
  const registro = await openSessionRegistry(
    path.join(dir, "state", "sesiones.json"),
  );
  const equipos = await openTeams(path.join(dir, "state", "equipos"), {
    activo: (id) =>
      registro
        .leer()
        .some(
          (s) => s.id === id && ["pendiente", "trabajando"].includes(s.estado),
        ),
  });
  const ejecutor = createExecutor({
    registro,
    equipos,
    proyectos: { prueba: dir },
    // The leader outlives its children, as a real leader waiting for them does.
    comando: (motor) => ({
      bin: process.execPath,
      args: [fake, motor === "claude" ? "15000" : "2500"],
    }),
  });
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const launcher = createLauncherServer({
    registro,
    equipos,
    ejecutor,
    controlHash: hash("control"),
    hookHash: hash("hook"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "app"),
    auth: true,
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
    for (const s of registro.leer().filter((s) => s.estado === "trabajando")) {
      await ejecutor.cancelar(s.id).catch(() => {});
      await ejecutor.esperar(s.id);
    }
    await app.close();
    await new Promise((resolve) => launcher.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  async function cliente(actor, sessionId) {
    // Short slices: the 5 s wait below crosses several of them, as a 30 min
    // wait crosses the 300 s limit of Node's fetch and HTTP servers.
    const server = createBrainMcp({
      baseUrl,
      token: "room",
      actor,
      sessionId,
      tramoEspera: 200,
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    clientes.push(client);
    return client;
  }
  async function llamar(client, name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    return JSON.parse(response.content[0].text);
  }
  const lider = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "coordina",
  });
  const ambar = await cliente("ambar", lider.id);
  const lira = await llamar(ambar, "equipo_encargar", {
    motor: "agy",
    brief: "investiga",
  });
  const menta = await llamar(ambar, "equipo_encargar", {
    motor: "codex",
    brief: "revisa",
  });
  const ayudante = await cliente("lira", lira.id);
  await llamar(ambar, "equipo_mensaje", {
    para: lira.id,
    texto: "Pregunta sintética",
  });
  assert.equal(
    (await llamar(ayudante, "equipo_bandeja"))[0].texto,
    "Pregunta sintética",
  );
  await llamar(ayudante, "equipo_entregar", {
    titulo: "Hallazgo",
    contenido: "Resultado sintético",
  });
  assert.equal(
    (await llamar(ambar, "equipo_estado")).entregables[0].de,
    lira.id,
  );
  assert.equal(
    (await llamar(ambar, "equipo_esperar", { id: menta.id, timeout: 1 }))
      .estado,
    "pendiente",
  );
  assert.equal(
    (await llamar(ambar, "equipo_esperar", { id: menta.id, timeout: 5000 }))
      .resultado,
    "listo",
  );
});
