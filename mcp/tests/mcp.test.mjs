import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "../../service/index.mjs";
import { createBrainMcp } from "../index.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("las agentes de la sala usan el MCP por CLI con credencial limitada y conservan los controles del vault", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-room-brain-"));
  const root = path.join(temp, "vault"),
    data = path.join(temp, "data");
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  for (const name of [
    "AGENTS.md",
    "Home.md",
    "99-Meta/Convenciones.md",
    "02-Areas/Agentes/_Agentes.md",
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), "# Reglas sintéticas\n");
  }
  const tokenFile = path.join(temp, "room-token");
  await writeFile(tokenFile, "room-test-token");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: data,
    auth: true,
    agentes: { tokenFile },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const headers = {
    authorization: "Bearer room-test-token",
    "content-type": "application/json",
  };
  const cli = fileURLToPath(new URL("../brain-cli.mjs", import.meta.url));
  const call = async (tool, args = {}) => {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [cli, tool, JSON.stringify(args)],
        {
          env: {
            ...process.env,
            SB_BRAIN_URL: baseUrl,
            SB_BRAIN_TOKEN_FILE: tokenFile,
          },
          timeout: 15000,
        },
      );
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch (e) {
      return { ok: false, error: e.stderr };
    }
  };
  try {
    const context = await call("brain_context");
    assert.equal(context.ok, true, context.error);
    assert.equal(context.value.length, 4);
    assert.equal((await call("brain_list")).ok, true);
    assert.equal(
      (await call("brain_search", { query: "sintéticas" })).ok,
      true,
    );
    const read = await call("brain_read", { path: "Home.md" });
    assert.equal(read.ok, true, read.error);
    assert.equal(
      (
        await call("brain_write", {
          path: "Home.md",
          content: "# Actualizado\n",
          expectedHash: read.value.hash,
        })
      ).ok,
      true,
    );
    const stale = await call("brain_write", {
      path: "Home.md",
      content: "stale",
      expectedHash: read.value.hash,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /409/);
    assert.equal(
      (await call("brain_read", { path: "../data/auth.json" })).ok,
      false,
    );
    assert.equal(
      (
        await call("brain_write", {
          path: "02-Areas/Finanzas/Datos-financieros.md",
          content: "invalid",
          expectedHash: null,
        })
      ).ok,
      false,
    );
    assert.equal((await call("brain_finance")).ok, true);
    assert.equal(
      (await fetch(baseUrl + "/vault/files", { headers })).status,
      200,
    );
    for (const [method, route] of [
      ["GET", "/items"],
      ["GET", "/agentes"],
      ["POST", "/agentes/encargos"],
      ["POST", "/auth/setup"],
      ["GET", "/export"],
      ["GET", "/auth/csrf"],
    ]) {
      assert.equal(
        (
          await fetch(baseUrl + route, {
            method,
            headers,
            ...(method === "POST" ? { body: "{}" } : {}),
          })
        ).status,
        403,
        route,
      );
    }
    assert.equal((await fetch(baseUrl + "/vault/files")).status, 401);
    assert.equal(
      await readFile(path.join(root, "Home.md"), "utf8"),
      "# Actualizado\n",
    );
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("MCP reads and updates original Markdown through the single API, detects stale edits and rejects traversal", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-mcp-"));
  const root = path.join(temp, "vault"),
    data = path.join(temp, "data");
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Synthetic vault\n");
  await writeFile(
    path.join(root, "00-Inbox/Note.md"),
    "---\ncustom: preserved\n---\nOriginal\n",
  );
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: data,
    auth: true,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const token = await readFile(path.join(data, "agent-token"), "utf8");
  const server = createBrainMcp({ baseUrl, token });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const call = async (name, args) =>
      client.callTool({ name, arguments: args });
    const parsed = (r) => JSON.parse(r.content[0].text);
    const listed = parsed(await call("brain_list", {}));
    assert.ok(listed.includes("00-Inbox/Note.md"));
    const original = parsed(
      await call("brain_read", { path: "00-Inbox/Note.md" }),
    );
    const updated = await call("brain_write", {
      path: original.path,
      content: original.content.replace("Original", "Updated"),
      expectedHash: original.hash,
    });
    assert.equal(updated.isError, undefined);
    assert.match(
      await readFile(path.join(root, original.path), "utf8"),
      /custom: preserved[\s\S]*Updated/,
    );
    const stale = await call("brain_write", {
      path: original.path,
      content: "stale",
      expectedHash: original.hash,
    });
    assert.equal(stale.isError, true);
    assert.match(
      await readFile(path.join(root, original.path), "utf8"),
      /Updated/,
    );
    assert.equal(
      (await call("brain_read", { path: "../data/auth.json" })).isError,
      true,
    );
    assert.equal(
      (
        await call("brain_write", {
          path: "02-Areas/Finanzas/Datos-financieros.md",
          content: "manual",
          expectedHash: null,
        })
      ).isError,
      true,
    );
    const create = await call("brain_write", {
      path: "00-Inbox/New.md",
      content: "# New\n",
      expectedHash: null,
    });
    assert.equal(create.isError, undefined);
    assert.equal(
      (
        await call("brain_write", {
          path: "00-Inbox/New.md",
          content: "overwrite",
          expectedHash: null,
        })
      ).isError,
      true,
    );
    const unauthed = await fetch(baseUrl + "/vault/note?path=Home.md");
    assert.equal(unauthed.status, 401);
    const denied = await fetch(baseUrl + "/vault/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "Home.md",
        content: "overwrite",
        expectedHash: null,
      }),
    });
    assert.equal(denied.status, 400);
  } finally {
    await client.close();
    await server.close();
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
