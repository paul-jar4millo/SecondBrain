// The same MCP tools through a shell, for providers without native MCP support.
// No vault mirror, tokens in arguments, or provider-specific APIs.
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcp, resolveServerCapability } from "./index.mjs";

let client, server;
try {
  const [name, input] = process.argv.slice(2);
  if (
    !/^(brain|files|motor|equipo|usuario)_/.test(name ?? "") ||
    !process.env.SB_BRAIN_TOKEN_FILE
  )
    throw new Error(
      'Uso: node brain-cli.mjs brain_context | brain_read \'{"path":"Home.md"}\'. Para JSON largo: brain_write --stdin < cambio.json. El servicio debe configurar SB_BRAIN_TOKEN_FILE.',
    );
  let json = input;
  if (input === "--stdin") {
    json = "";
    for await (const chunk of process.stdin) {
      json += chunk;
      if (Buffer.byteLength(json) > 3 * 1024 * 1024)
        throw new Error("La entrada supera 3 MB.");
    }
  }
  const token = (
    await readFile(process.env.SB_BRAIN_TOKEN_FILE, "utf8")
  ).trim();
  const baseUrl = process.env.SB_BRAIN_URL || "http://127.0.0.1:8080/api/v1";
  const allowedOperations = await resolveServerCapability({ baseUrl, token });
  server = createBrainMcp({
    baseUrl,
    token,
    actor: process.env.SB_AGENTE,
    sessionId: process.env.SB_SESSION_ID,
    descargasLocales: true,
    allowedOperations,
  });
  client = new Client({ name: "secondbrain-room", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const result =
    /** @type {{ isError?: boolean, content: Array<{ type: string, text?: string }> }} */ (
      await client.callTool({
        name,
        arguments: JSON.parse(json || "{}"),
      })
    );
  if (result.isError)
    throw new Error(
      result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  // MCP text already contains JSON. stdout is machine-readable, stderr is errors.
  process.stdout.write(
    result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") + "\n",
  );
} catch (e) {
  process.stderr.write(`SecondBrain: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await client?.close();
  await server?.close();
}
