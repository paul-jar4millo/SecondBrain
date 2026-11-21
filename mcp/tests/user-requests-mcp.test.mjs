import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcp } from "../index.mjs";
import { createApplication } from "../../service/index.mjs";
import { getCsrfHeaders } from "../../service/tests/helpers/csrf.mjs";

test("herramientas MCP usuario_preguntar, usuario_consultar_respuesta y usuario_esperar_respuesta esperan por tramos la respuesta", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-mcp-req-"));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético MCP\n");

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");

  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const server = createBrainMcp({
    baseUrl,
    token: "room-secret",
    actor: "ambar",
    sessionId: randomUUID(),
    tramoEspera: 80,
  });
  const client = new Client({ name: "test-req-mcp", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  t.after(async () => {
    await client.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function llamar(name, args) {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    return JSON.parse(res.content[0].text);
  }

  const appHeaders = await getCsrfHeaders(baseUrl);

  // 1) Agent asks a non-blocking persistent question
  const asked = await llamar("usuario_preguntar", {
    titulo: "Prioridad sintética",
    pregunta: "¿Qué ruta priorizamos primero?",
    opciones: ["Ruta A", "Ruta B"],
  });
  assert.equal(asked.ok, true);
  assert.equal(asked.solicitud.status, "pendiente");
  assert.equal(asked.solicitud.nativeCallbackStatus, "not_applicable");

  // 2) Agent polls non-blocking status
  const polled = await llamar("usuario_consultar_respuesta", {
    id: asked.solicitud.id,
  });
  assert.equal(polled.solicitud.status, "pendiente");

  // 3) Agent waits across multiple short slices while user responds concurrently
  const waitPromise = llamar("usuario_esperar_respuesta", {
    id: asked.solicitud.id,
    timeout: 2000,
  });
  await new Promise((r) => setTimeout(r, 150));

  const userResp = await fetch(`${baseUrl}/requests/answer`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: asked.solicitud.id,
      requestId: randomUUID(),
      option: "Ruta B",
    }),
  });
  assert.equal(userResp.status, 200);

  const waited = await waitPromise;
  assert.equal(waited.solicitud.status, "respuesta_recibida");
  assert.equal(waited.solicitud.response.answer, "Ruta B");
});
