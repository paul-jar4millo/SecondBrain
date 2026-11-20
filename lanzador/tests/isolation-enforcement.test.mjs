import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { test } from "node:test";
import { TOOL_PROFILES_BASE } from "../tool-catalog.mjs";
import { crearEjecutor } from "../executor.mjs";
import {
  createAcpController,
  createClaudeController,
  createCodexController,
  parseCodexMcpServerEntries,
  parseCodexMcpServerKeys,
} from "../provider-controllers.mjs";
import { createProviderConversations } from "../provider-conversations.mjs";
import { abrirRegistro } from "../sessions.mjs";

const execFileAsync = promisify(execFile);

function createStreamFakeProcess(onRpcMessage) {
  const child = new EventEmitter();
  child.pid = 91001;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let buf = "";
  const send = (obj) => {
    child.stdout.write(JSON.stringify(obj) + "\n");
  };
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString("utf8");
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onRpcMessage(JSON.parse(line), send, child);
      }
      cb();
    },
  });
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

async function resolveRealCodexBin() {
  if (process.env.SB_CODEX_BIN) return process.env.SB_CODEX_BIN;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage OpenAI.Codex).InstallLocation",
      ]);
      const loc = stdout.trim();
      if (loc) {
        const candidate = path.join(loc, "app", "resources", "codex.exe");
        await access(candidate);
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(cmd, ["codex"]);
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

test("C: parser TOML v1.0 decodifica \\u005f/literales/tablas inline, ignora falsos multilínea y falla cerrado en claves con punto", () => {
  const toml = [
    'mcp_servers.inline_srv = { command = "node", enabled = true }',
    "",
    'prompt = """',
    "[mcp_servers.falso_en_multilinea]",
    'command = "nope"',
    '"""',
    "",
    '[mcp_servers."hidden\\u005fconnector"]',
    'command = "node"',
    "",
    "[mcp_servers.'literal_srv']",
    'command = "node"',
    "enabled = true",
    "",
    '[mcp_servers."disabled_srv"]',
    'command = "node"',
    "enabled = false",
    "",
    '[mcp_servers."hidden.dot"]',
    'command = "node"',
    "enabled = true",
  ].join("\n");

  const entries = parseCodexMcpServerEntries(toml);
  const keys = parseCodexMcpServerKeys(toml);

  assert.equal(keys.has("falso_en_multilinea"), false);
  assert.deepEqual([...keys].sort(), [
    "disabled_srv",
    "hidden.dot",
    "hidden_connector",
    "inline_srv",
    "literal_srv",
  ]);
  assert.equal(entries.get("hidden_connector").enabled, true);
  assert.equal(entries.get("disabled_srv").enabled, false);
  assert.equal(entries.get("inline_srv").enabled, true);
  assert.equal(entries.get("hidden.dot").enabled, true);
});

test("C: camina .codex ancestro sintético hasta raíz y bloquea clave con punto o fuga en config/read antes de spawn/thread/start", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-codex-anc-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  const codexHome = path.join(dir, "codex-home");
  const ancRoot = path.join(dir, "workspace-root");
  const deepProj = path.join(ancRoot, "nivel1", "nivel2", "proyecto");
  const sentinelFile = path.join(dir, "sentinel.txt");
  const sentinelScript = path.join(dir, "sentinel-mcp.mjs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(ancRoot, ".codex"), { recursive: true });
  await mkdir(deepProj, { recursive: true });
  await writeFile(
    sentinelScript,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinelFile)}, "LEAK");`,
  );

  // Ancestor config enables hidden\u005fconnector + clean disables
  await writeFile(
    path.join(ancRoot, ".codex", "config.toml"),
    [
      '[mcp_servers."hidden\\u005fconnector"]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(sentinelScript)}]`,
      "enabled = true",
    ].join("\n"),
  );

  let spawnedArgs = null;
  let threadStarted = false;
  let leakConfigRead = false;

  const makeCtx = () => ({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "codex" },
    cwd: deepProj,
    prompt: "inspect",
    mcpServers: {},
    verifyMcpRuntime: true,
    requireConfigRead: true,
    useCodexMcpList: false,
    systemCodexConfigDir: null,
    env: { CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir },
    operatorEnv: { CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir },
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
      spawnedArgs = [...args];
      return createStreamFakeProcess((msg, send) => {
        if (msg.method === "initialize") {
          send({
            id: msg.id,
            result: { codexHome, userAgent: "codex-cli/test" },
          });
        } else if (msg.method === "mcpServerStatus/list") {
          send({ id: msg.id, result: { data: [] } });
        } else if (msg.method === "config/read") {
          send({
            id: msg.id,
            result: {
              config: {
                mcp_servers: leakConfigRead
                  ? { rogue_server: { enabled: true } }
                  : { hidden_connector: { enabled: false } },
              },
            },
          });
        } else if (msg.method === "thread/start") {
          threadStarted = true;
          send({ id: msg.id, result: { thread: { id: "thr-1" } } });
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

  const c1 = createCodexController();
  await c1.runTurn(makeCtx());
  assert.ok(spawnedArgs.includes("mcp_servers.hidden_connector.enabled=false"));
  assert.equal(threadStarted, true);
  await c1.shutdown();

  // Fail closed when config/read leaks rogue enabled server (BEFORE thread/start!)
  threadStarted = false;
  leakConfigRead = true;
  const c2 = createCodexController();
  await assert.rejects(
    () => c2.runTurn(makeCtx()),
    /Aislamiento MCP de Codex violado/,
  );
  assert.equal(threadStarted, false);
  await c2.shutdown();

  // Fail closed on dotted key hidden.dot BEFORE spawn
  leakConfigRead = false;
  let spawnedOnDotted = false;
  await writeFile(
    path.join(ancRoot, ".codex", "config.toml"),
    '[mcp_servers."hidden.dot"]\ncommand = "node"\nenabled = true\n',
  );
  const c3 = createCodexController();
  const dottedCtx = makeCtx();
  dottedCtx.spawn = () => {
    spawnedOnDotted = true;
    return createStreamFakeProcess(() => {});
  };
  await assert.rejects(() => c3.runTurn(dottedCtx), /no aislable/i);
  assert.equal(spawnedOnDotted, false);
  await assert.rejects(access(sentinelFile));
});

test("C (empírico binario real Codex): verifica aislamiento real con codex mcp list y config/read sin ejecutar servidor centinela", async (t) => {
  const realCodex = await resolveRealCodexBin();
  if (!realCodex) {
    t.skip("Binario real codex no instalado en este host");
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-real-codex-iso-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  const codexHome = path.join(dir, "codex-home");
  const projDir = path.join(dir, "proj");
  const sentinelOut = path.join(dir, "sentinel-executed.txt");
  const sentinelJs = path.join(dir, "sentinel.mjs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(projDir, { recursive: true });
  await writeFile(
    sentinelJs,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinelOut)}, "RAN");`,
  );

  // Case 1: Unicode-escaped key disabled via CLI, real codex mcp list + initialize + config/read confirms enabled=false, sentinel NEVER runs
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      '[mcp_servers."hidden\\u005fconnector"]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(sentinelJs)}]`,
      "enabled = true",
    ].join("\n"),
  );

  const { createCodexController: _unused, ..._ } = {};
  const ctrl = createCodexController();
  let observedEffective = null;
  const { spawn } = await import("node:child_process");
  // Exercise preflight + handshake directly via controller up to config/read; real thread/start needs OpenAI auth in isolated CODEX_HOME
  try {
    await ctrl.runTurn({
      turnId: randomUUID(),
      session: { id: randomUUID(), motor: "codex" },
      cwd: projDir,
      prompt: "solo probar handshake",
      mcpServers: {},
      verifyMcpRuntime: true,
      requireConfigRead: true,
      useCodexMcpList: true,
      systemCodexConfigDir: null,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: dir,
        USERPROFILE: dir,
      },
      operatorEnv: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: dir,
        USERPROFILE: dir,
        SB_CODEX_BIN: realCodex,
      },
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
      spawn(bin, args, spawnEnv) {
        observedEffective = { bin, args: [...args] };
        return spawn(bin, args, {
          cwd: projDir,
          env: spawnEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
  } catch (err) {
    // Expect either thread/start auth error (no creds in isolated CODEX_HOME) or completion — NEVER MCP isolation leak!
    assert.doesNotMatch(err?.message || "", /Aislamiento MCP de Codex violado/);
  } finally {
    await ctrl.shutdown().catch(() => {});
  }
  assert.ok(
    observedEffective,
    "Debe haber ejecutado real codex binary tras preflight",
  );
  assert.ok(
    observedEffective.args.includes(
      "mcp_servers.hidden_connector.enabled=false",
    ),
  );
  await assert.rejects(
    access(sentinelOut),
    "Sentinel MCP no debe haberse ejecutado nunca",
  );

  // Case 2: Dotted un-overridable key fails closed BEFORE even spawning real codex.exe
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      '[mcp_servers."hidden.dot"]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(sentinelJs)}]`,
      "enabled = true",
    ].join("\n"),
  );
  let spawnedDotted = false;
  const ctrlDotted = createCodexController();
  await assert.rejects(
    () =>
      ctrlDotted.runTurn({
        turnId: randomUUID(),
        session: { id: randomUUID(), motor: "codex" },
        cwd: projDir,
        prompt: "hola",
        mcpServers: {},
        useCodexMcpList: true,
        systemCodexConfigDir: null,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          HOME: dir,
          USERPROFILE: dir,
        },
        operatorEnv: {
          ...process.env,
          CODEX_HOME: codexHome,
          HOME: dir,
          USERPROFILE: dir,
          SB_CODEX_BIN: realCodex,
        },
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
        spawn() {
          spawnedDotted = true;
          throw new Error("should not spawn");
        },
      }),
    /no aislable/i,
  );
  assert.equal(spawnedDotted, false);
  await assert.rejects(access(sentinelOut));
});

test("B/E: bloqueo de gasto antes de spawn y consultarSaldo, perfiles edit/shell denegados y limpieza de secretos", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-spend-prof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data");
  const projDir = path.join(dir, "proj");
  await mkdir(projDir, { recursive: true });

  // 1. Profile tool enforcement inside Codex, ACP, and Claude controllers
  let claudeOptions = null;
  let claudeCanWrite = null;
  const claudeCtrl = createClaudeController(({ prompt, options }) => {
    claudeOptions = options;
    return {
      async interrupt() {},
      close() {},
      async *[Symbol.asyncIterator]() {
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        claudeCanWrite = await options.canUseTool("Write", {
          file_path: "x.md",
        });
        yield {
          type: "result",
          subtype: "success",
          result: "denied-checked",
          session_id: "c-prof",
        };
      },
    };
  });
  await claudeCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "claude" },
    cwd: projDir,
    prompt: "hola",
    mcpServers: {},
    toolProfile: TOOL_PROFILES_BASE.investigacion,
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
    ask: async () => ({ decision: "allow" }),
  });
  assert.ok(claudeOptions.disallowedTools.includes("Write"));
  assert.ok(claudeOptions.disallowedTools.includes("Bash"));
  assert.equal(claudeCanWrite.behavior, "deny");
  await claudeCtrl.shutdown();

  // ACP permission denial for write under investigacion without even asking user
  let askedAcpUser = false;
  let acpPermissionResult = null;
  const acpCtrl = createAcpController();
  await acpCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "agy" },
    cwd: projDir,
    prompt: "hola",
    mcpServers: {},
    toolProfile: TOOL_PROFILES_BASE.investigacion,
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
    ask: async () => {
      askedAcpUser = true;
      return { decision: "allow_once" };
    },
    spawn() {
      return createStreamFakeProcess((msg, send) => {
        if (msg.method === "initialize") {
          send({ id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === "session/new") {
          send({ id: msg.id, result: { sessionId: "acp-prof" } });
        } else if (msg.method === "session/prompt") {
          send({
            id: 77,
            method: "session/request_permission",
            params: {
              sessionId: "acp-prof",
              toolCall: {
                toolCallId: "tc-1",
                kind: "edit",
                title: "write_file",
              },
              options: [
                { optionId: "allow_once", kind: "allow_once", name: "Allow" },
              ],
            },
          });
        } else if (msg.id === 77) {
          acpPermissionResult = msg.result;
          send({ id: 3, result: { stopReason: "end_turn" } });
        }
      });
    },
  });
  assert.equal(askedAcpUser, false);
  assert.equal(acpPermissionResult.outcome.outcome, "cancelled");
  await acpCtrl.shutdown();

  // 2. DeepSeek spending policy blocked BEFORE spawn and BEFORE consultarSaldo, ignoring spoofed billingAuthorized
  let saldoCalls = 0;
  let claudeSdkCalled = false;
  const registro = await abrirRegistro(path.join(dataDir, "sesiones.json"));
  const conversations = createProviderConversations({
    directory: path.join(dataDir, "conv"),
    registro,
    adapters: {
      claude: {
        createController: () =>
          createClaudeController(() => {
            claudeSdkCalled = true;
            return { close() {}, async *[Symbol.asyncIterator]() {} };
          }),
      },
      deepseek: {
        createController: () =>
          createClaudeController(() => {
            claudeSdkCalled = true;
            return { close() {}, async *[Symbol.asyncIterator]() {} };
          }),
      },
    },
  });
  const ejecutor = crearEjecutor({
    registro,
    equipos: {
      estado: () => ({ id: "eq-1", miembros: [] }),
      crear: async () => ({ id: "eq-1", miembros: [] }),
      comprobar: () => {},
      agregar: async () => {},
    },
    proyectos: { demo: projDir },
    env: {
      SB_LANZADOR_DATA_DIR: dataDir,
      AGENTES_TOKEN_FILE: path.join(dir, "supervisor-room"),
      GITHUB_TOKEN: "ghp_should_never_leak",
      DEEPSEEK_API_KEY: "sk-should-never-leak",
    },
    conversations,
    consultarSaldo: async () => {
      saldoCalls += 1;
      return 10.0;
    },
    registrar: () => {},
  });

  await assert.rejects(
    () =>
      ejecutor.encargar({
        motor: "deepseek",
        origen: "encargo",
        proyecto: "demo",
        brief: "gastar sin permiso",
        structured: true,
        billingAuthorized: true, // spoofed!
      }),
    /gasto/,
  );
  assert.equal(claudeSdkCalled, false);

  // Structured coordinator (investigacion) spawning child deepseek -> spending policy BEFORE consultarSaldo()!
  let observedLeaderEnv = null;
  const conversationsSpy = createProviderConversations({
    directory: path.join(dataDir, "conv2"),
    registro,
    adapters: {
      claude: {
        createController: () => ({
          runTurn: async (ctx) => {
            observedLeaderEnv = ctx.env;
            await new Promise((r) => setTimeout(r, 80));
            return { text: "ok", status: "completed", persistent: false };
          },
          async shutdown() {},
          isAlive: () => false,
          pid: () => null,
        }),
      },
    },
  });
  const exec2 = crearEjecutor({
    registro,
    equipos: {
      estado: () => ({ id: "eq-2", miembros: [] }),
      crear: async () => ({ id: "eq-2", miembros: [] }),
      comprobar: () => {},
      agregar: async () => {},
    },
    proyectos: { demo: projDir },
    env: {
      SB_LANZADOR_DATA_DIR: dataDir,
      AGENTES_TOKEN_FILE: path.join(dir, "supervisor-room"),
      AGENTES_SECRETO: "super-secret",
      GITHUB_TOKEN: "ghp_should_never_leak",
      DEEPSEEK_API_KEY: "sk-should-never-leak",
    },
    conversations: conversationsSpy,
    consultarSaldo: async () => {
      saldoCalls += 1;
      return 10.0;
    },
    registrar: () => {},
  });

  const leader = await exec2.encargar({
    motor: "claude",
    origen: "encargo",
    proyecto: "demo",
    brief: "coordina",
    structured: true,
    toolProfileId: "investigacion",
    capabilityToken: "sbcap_leader_scoped",
  });
  await assert.rejects(
    () =>
      exec2.encargarHija(leader.id, {
        motor: "deepseek",
        brief: "subtarea facturada",
      }),
    /gasto/,
  );
  assert.equal(saldoCalls, 0);

  await exec2.esperar(leader.id);
  assert.equal(observedLeaderEnv.AGENTES_TOKEN_FILE, undefined);
  assert.equal(observedLeaderEnv.AGENTES_SECRETO, undefined);
  assert.equal(observedLeaderEnv.GITHUB_TOKEN, undefined);
  assert.equal(observedLeaderEnv.DEEPSEEK_API_KEY, undefined);
  assert.ok(observedLeaderEnv.SB_BRAIN_TOKEN_FILE);
  assert.equal(
    (await readFile(observedLeaderEnv.SB_BRAIN_TOKEN_FILE, "utf8")).trim(),
    "sbcap_leader_scoped",
  );
  // sesiones.json must NEVER store plaintext capabilityToken
  const persisted = await readFile(path.join(dataDir, "sesiones.json"), "utf8");
  assert.doesNotMatch(persisted, /sbcap_leader_scoped/);
});
