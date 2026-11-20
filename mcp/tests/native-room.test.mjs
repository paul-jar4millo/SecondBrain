import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("el MCP stdio usa la credencial de sala y atribuye la agente", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = path.join(dir, "token");
  await writeFile(token, "sala-test\n");
  const observed = [];
  const api = http.createServer((req, res) => {
    observed.push({
      auth: req.headers.authorization,
      actor: req.headers["x-sb-agente"],
      session: req.headers["x-sb-sesion"],
    });
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.mjs", import.meta.url))],
    env: {
      ...process.env,
      SB_BRAIN_URL: `http://127.0.0.1:${api.address().port}/api/v1`,
      SB_BRAIN_TOKEN_FILE: token,
      SB_AGENTE: "menta",
      SB_SESSION_ID: "session-test",
    },
  });
  const client = new Client({ name: "test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: "brain_list", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(observed, [
    { auth: "Bearer sala-test", actor: "menta", session: "session-test" },
  ]);
  const herramientas = await client.listTools();
  assert.ok(
    herramientas.tools.every((tool) => !tool.name.startsWith("equipo_")),
  );
});
