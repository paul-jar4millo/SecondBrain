import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "../../service/index.mjs";
import { isToolAllowedForOperations } from "../index.mjs";

const execFileAsync = promisify(execFile);

async function setupOwnerClient(baseRoot) {
  const csrfRes = await fetch(`${baseRoot}/api/v1/auth/csrf`);
  const { token: csrfToken } = await csrfRes.json();
  let cookieHeader = csrfRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const setupRes = await fetch(`${baseRoot}/api/v1/auth/setup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
      "x-csrf-token": csrfToken,
      origin: baseRoot,
    },
    body: JSON.stringify({
      username: "owner",
      password: "una-clave-larga-segura-123",
    }),
  });
  assert.equal(setupRes.status, 200);
  const setupCookies = setupRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]);
  const map = new Map();
  for (const c of [...cookieHeader.split("; "), ...setupCookies]) {
    if (!c) continue;
    const eq = c.indexOf("=");
    if (eq > 0) map.set(c.slice(0, eq), c.slice(eq + 1));
  }
  cookieHeader = [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrf2 = await fetch(`${baseRoot}/api/v1/auth/csrf`, {
    headers: { cookie: cookieHeader },
  });
  const { token: csrfAfter } = await csrf2.json();
  return {
    cookie: cookieHeader,
    csrf: csrfAfter,
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
      "x-csrf-token": csrfAfter,
      origin: baseRoot,
    },
  };
}

test("B: MCP stdio y brain-cli omiten herramientas fuera de perfil, ignoran SB_TOOL_PROFILE falsificado y bloquean calls directos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-mcp-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vaultRoot = path.join(dir, "vault");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "Home.md"),
    "# Nota Inicial\nContenido intacto.\n",
  );

  const app = await createApplication({
    vaultRoot,
    dataDirectory: path.join(dir, "service-data"),
    auth: true,
    agentes: {
      brainToken: "room-master-secret",
      agentToken: "agent-supervisor-secret",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());

  const baseRoot = `http://127.0.0.1:${app.server.address().port}`;
  const baseApi = `${baseRoot}/api/v1`;
  const owner = await setupOwnerClient(baseRoot);

  // Mint scoped investigacion capability token as authenticated owner/supervisor
  const capRes = await fetch(`${baseApi}/agents/capabilities/token`, {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      memberId: "lira-1",
      actor: "lira",
      profileId: "investigacion",
    }),
  });
  assert.equal(capRes.status, 201);
  const { token: capToken } = await capRes.json();
  assert.ok(capToken.startsWith("sbcap_"));

  // Scoped agent token CANNOT mint further tokens (403)
  const mintDenied = await fetch(`${baseApi}/agents/capabilities/token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ profileId: "ejecucion" }),
  });
  assert.equal(mintDenied.status, 403);

  const tokenFile = path.join(dir, "cap.token");
  await writeFile(tokenFile, capToken, { mode: 0o600 });

  // Connect real MCP stdio with spoofed SB_TOOL_PROFILE=ejecucion in env (MUST be ignored!)
  const mcpEntry = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: {
      ...process.env,
      SB_BRAIN_URL: baseApi,
      SB_BRAIN_TOKEN_FILE: tokenFile,
      SB_AGENTE: "lira",
      SB_TOOL_PROFILE: "ejecucion", // spoof attempt!
    },
  });
  const client = new Client({ name: "cap-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);

  // tools/list MUST include read tools and OMIT write/finance-write/upload/delegate tools
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const allowed of [
    "brain_context",
    "brain_list",
    "brain_read",
    "brain_search",
    "brain_finance",
    "files_list",
    "files_get",
  ]) {
    assert.ok(names.has(allowed), `Expected tool ${allowed}`);
  }
  for (const omitted of [
    "brain_write",
    "brain_finance_operation",
    "files_put",
    "files_upload",
    "files_trash",
  ]) {
    assert.equal(names.has(omitted), false, `Tool ${omitted} must be omitted`);
  }

  // Allowed read succeeds
  const readRes = await client.callTool({
    name: "brain_read",
    arguments: { path: "Home.md" },
  });
  assert.notEqual(readRes.isError, true);

  // Direct tools/call on omitted write/finance/delegate tools fails closed
  for (const call of [
    { name: "brain_write", arguments: { path: "Home.md", content: "# Hax" } },
    {
      name: "brain_finance_operation",
      arguments: {
        kind: "charge",
        card: "Nu",
        amount: 100,
        description: "x",
        ref: "r1",
      },
    },
  ]) {
    let thrown = null;
    let res = null;
    try {
      res = await client.callTool(call);
    } catch (err) {
      thrown = err;
    }
    if (!thrown) {
      assert.equal(res?.isError, true, `${call.name} must fail closed`);
      const msg = res.content.map((c) => c.text || "").join("\n");
      assert.match(msg, /not found|403|permitida|Tool .* not found/i);
    }
  }

  // brain-cli.mjs also enforces server capability & fails closed on disallowed write even with SB_TOOL_PROFILE=ejecucion
  const cliEntry = fileURLToPath(new URL("../brain-cli.mjs", import.meta.url));
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliEntry, "brain_read", '{"path":"Home.md"}'],
    {
      env: {
        ...process.env,
        SB_BRAIN_URL: baseApi,
        SB_BRAIN_TOKEN_FILE: tokenFile,
        SB_AGENTE: "lira",
        SB_TOOL_PROFILE: "ejecucion",
      },
    },
  );
  assert.match(stdout, /Contenido intacto/);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliEntry, "brain_write", '{"path":"Home.md","content":"# Mutado"}'],
      {
        env: {
          ...process.env,
          SB_BRAIN_URL: baseApi,
          SB_BRAIN_TOKEN_FILE: tokenFile,
          SB_AGENTE: "lira",
          SB_TOOL_PROFILE: "ejecucion",
        },
      },
    ),
  );
});

test("thread_ask_user follows user.ask like the usuario_* tools", () => {
  assert.equal(
    isToolAllowedForOperations("thread_ask_user", new Set(["user.ask"])),
    true,
  );
  assert.equal(
    isToolAllowedForOperations("thread_ask_user", new Set(["vault.read"])),
    false,
  );
});
