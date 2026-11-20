import assert from "node:assert/strict";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test } from "node:test";

import {
  createAcpController,
  createClaudeController,
  createCodexController,
  parseCodexMcpServerKeys,
} from "../provider-controllers.mjs";

import { createStreamFakeProcess } from "./helpers/provider-fakes.mjs";

test("regresión: aislamiento real fail-closed para MCP desconocido en Codex, ACP sin geminiDir y Claude sin settingSources explícito", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-iso-fail-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  const codexHome = path.join(dir, "codex-home");
  const projDir = path.join(dir, "proj");
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(projDir, ".codex"), { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      "[mcp_servers.conector_desconocido]",
      'command = "node"',
      'args = ["-e", "0"]',
      "enabled = true",
      "",
      "[mcp_servers.conector_url]",
      'url = "https://example.invalid/mcp"',
      "enabled = true",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projDir, ".codex", "config.toml"),
    '[mcp_servers.proyecto_extra]\ncommand = "node"\nenabled = true\n',
  );

  // Parser discovers all three custom MCPs
  const keys = parseCodexMcpServerKeys(
    await readFile(path.join(codexHome, "config.toml"), "utf8"),
  );
  assert.deepEqual([...keys].sort(), ["conector_desconocido", "conector_url"]);

  // Controller passes .enabled=false for every discovered unknown MCP and rejects if mcpServerStatus/list shows active leak
  let observedArgs = null;
  let simulateLeak = false;
  const makeCtrlCtx = () => ({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "codex" },
    cwd: projDir,
    prompt: "hola",
    mcpServers: {},
    verifyMcpRuntime: true,
    env: { CODEX_HOME: codexHome },
    operatorEnv: { CODEX_HOME: codexHome },
    message: () => {},
    delta: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({ decision: "cancel" }),
    spawn(_bin, args) {
      observedArgs = [...args];
      return createStreamFakeProcess((msg, send) => {
        if (msg.method === "initialize") {
          send({
            id: msg.id,
            result: { codexHome, userAgent: "codex-cli/0.169" },
          });
        } else if (msg.method === "mcpServerStatus/list") {
          send({
            id: msg.id,
            result: {
              data: simulateLeak
                ? [
                    {
                      name: "conector_desconocido",
                      serverInfo: { name: "bad" },
                      tools: { leak: {} },
                      runtimeStatus: "connected",
                    },
                  ]
                : [
                    {
                      name: "conector_desconocido",
                      serverInfo: null,
                      tools: {},
                      runtimeStatus: null,
                    },
                  ],
            },
          });
        } else if (msg.method === "thread/start") {
          send({ id: msg.id, result: { thread: { id: "th-1" } } });
        } else if (msg.method === "turn/start") {
          send({ id: msg.id, result: { turn: { id: "t-1" } } });
          send({
            method: "turn/completed",
            params: { turn: { id: "t-1", status: "completed" } },
          });
        }
      });
    },
  });

  const cClean = createCodexController();
  await cClean.runTurn(makeCtrlCtx());
  assert.ok(
    observedArgs.includes("mcp_servers.conector_desconocido.enabled=false"),
  );
  assert.ok(observedArgs.includes("mcp_servers.conector_url.enabled=false"));
  assert.ok(observedArgs.includes("mcp_servers.proyecto_extra.enabled=false"));
  await cClean.shutdown();

  // Fail closed when mcpServerStatus/list reports active non-allowlisted server BEFORE thread/start
  simulateLeak = true;
  const cLeak = createCodexController();
  await assert.rejects(
    () => cLeak.runTurn(makeCtrlCtx()),
    /Aislamiento MCP de Codex violado/,
  );
  await cLeak.shutdown();

  // Fail closed when config.toml contains unverifiable multiline syntax in mcp_servers
  await writeFile(
    path.join(codexHome, "config.toml"),
    'mcp_servers = """bad"""\n',
  );
  const cBadToml = createCodexController();
  await assert.rejects(
    () => cBadToml.runTurn(makeCtrlCtx()),
    /TOML|config\.toml|verificable/i,
  );

  // ACP WITHOUT ctx.geminiDir STILL isolates automatically (no fallback to bare ["acp"])
  let acpArgs = null;
  let acpGeminiHome = null;
  const acpIso = createAcpController();
  await acpIso.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "agy" },
    cwd: projDir,
    prompt: "hola",
    mcpServers: {},
    env: {},
    operatorEnv: {},
    message: () => {},
    delta: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({ decision: "cancel" }),
    spawn(_bin, args, spawnEnv) {
      acpArgs = [...args];
      acpGeminiHome = spawnEnv.GEMINI_HOME;
      return createStreamFakeProcess((msg, send) => {
        if (msg.method === "initialize")
          send({
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
          });
        else if (msg.method === "session/new")
          send({ id: msg.id, result: { sessionId: "acp-auto" } });
        else if (msg.method === "session/prompt")
          send({ id: msg.id, result: { stopReason: "end_turn" } });
      });
    },
  });
  assert.ok(acpArgs.includes("--gemini-dir"));
  assert.ok(acpArgs.includes("--include-default-customizations=false"));
  assert.ok(acpGeminiHome);
  await acpIso.shutdown();

  // Claude controller WITHOUT explicit mcpServers/settingSources STILL sets settingSources: []
  let claudeOpts = null;
  const clIso = createClaudeController(({ prompt, options }) => {
    claudeOpts = options;
    return {
      async interrupt() {},
      close() {},
      async *[Symbol.asyncIterator]() {
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "c-def",
        };
      },
    };
  });
  await clIso.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "claude" },
    cwd: projDir,
    prompt: "hola",
    env: {},
    operatorEnv: {},
    message: () => {},
    delta: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({ decision: "cancel" }),
    spawn: () => {},
  });
  assert.deepEqual(claudeOpts.settingSources, []);
  assert.equal(claudeOpts.strictMcpConfig, true);
  await clIso.shutdown();
});
