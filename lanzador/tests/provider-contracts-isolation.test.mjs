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

import {
  createHarness,
  createStreamFakeProcess,
} from "./helpers/provider-fakes.mjs";

test("contrato 6: mcpServers: {} mantiene 0 MCPs incluso con SB_BRAIN_TOKEN_FILE; aísla ACP y Codex sin conectores heredados", async (t) => {
  const tokenDir = await mkdtemp(path.join(os.tmpdir(), "sb-tok-"));
  t.after(() => rm(tokenDir, { recursive: true, force: true }));
  const tokenFile = path.join(tokenDir, "brain.token");
  await writeFile(tokenFile, "fake-token-never-used", "utf8");

  let observedClaudeOptions = null;
  const h = await createHarness(t, {
    emptyMcps: true,
    env: {
      SB_BRAIN_TOKEN_FILE: tokenFile,
      SB_SERVICE_URL: "http://127.0.0.1:9999",
    },
    claudeControllerFactory: () =>
      createClaudeController(({ prompt, options }) => {
        observedClaudeOptions = options;
        return {
          async interrupt() {},
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              async next() {
                if (!sent) {
                  sent = true;
                  const iter = prompt[Symbol.asyncIterator]();
                  await iter.next();
                  return {
                    value: {
                      type: "result",
                      subtype: "success",
                      result: "isolated-claude",
                      session_id: "c-iso",
                    },
                    done: false,
                  };
                }
                return { value: undefined, done: true };
              },
              return() {
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      }),
  });

  // Codex empty MCPs
  const sc = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "codex-isolated",
    structured: true,
  });
  await h.ejecutor.esperar(sc.id);
  const codexSpawn = h.spawnedBinsAndArgs.find((x) => x.motor === "codex");
  assert.deepEqual(codexSpawn.mcpServers, {});
  assert.ok(codexSpawn.args.includes("--disable"));
  assert.ok(codexSpawn.args.includes("apps"));
  assert.ok(codexSpawn.args.includes("features.apps=false"));
  assert.ok(
    codexSpawn.args.includes(
      'mcp_servers.secondbrain={command="disabled",enabled=false}',
    ),
  );
  assert.equal(
    codexSpawn.args.some((a) => a.includes("enabled=true")),
    false,
  );

  // ACP empty MCPs + isolated gemini dir
  const sa = await h.ejecutor.encargar({
    motor: "agy",
    origen: "sala",
    proyecto: "demo",
    brief: "acp-isolated",
    structured: true,
  });
  await h.ejecutor.esperar(sa.id);
  const acpSpawn = h.spawnedBinsAndArgs.find((x) => x.motor === "agy");
  assert.deepEqual(acpSpawn.mcpServers, {});
  assert.ok(acpSpawn.args.includes("--gemini-dir"));
  assert.ok(acpSpawn.args.includes("--include-default-customizations=false"));
  assert.ok(acpSpawn.args.includes("--disable-telemetry"));
  const geminiIdx = acpSpawn.args.indexOf("--gemini-dir");
  const geminiDir = acpSpawn.args[geminiIdx + 1];
  const acpMcpConfig = JSON.parse(
    await readFile(path.join(geminiDir, "config", "mcp_config.json"), "utf8"),
  );
  assert.deepEqual(acpMcpConfig, { mcpServers: {} });
  const doneAcp = h.registro.leer().find((s) => s.id === sa.id);
  assert.match(doneAcp.resultado, /mcpCount=0/);

  // Claude empty MCPs
  const scl = await h.ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    brief: "claude-isolated",
    structured: true,
  });
  await h.ejecutor.esperar(scl.id);
  assert.deepEqual(observedClaudeOptions.mcpServers, {});
  assert.deepEqual(observedClaudeOptions.settingSources, []);
  assert.equal(observedClaudeOptions.strictMcpConfig, true);
  assert.equal(observedClaudeOptions.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

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
