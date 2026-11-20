// Fake Codex and ACP processes, a launcher harness around them and wait
// helpers shared by the provider contract tests.

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PassThrough, Writable } from "node:stream";

import { createToolCatalogStore } from "../../tool-catalog.mjs";
import { createExecutor } from "../../executor.mjs";

import {
  createAcpController,
  createCodexController,
} from "../../provider-controllers.mjs";
import { createProviderConversations } from "../../provider-conversations.mjs";
import { openSessionRegistry } from "../../sessions.mjs";

export const FAKE_CODEX_SCRIPT = `
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CODEX_MODE || "persistent";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const turns = [];
let activeTimer = null;
let activeTurn = null;
let elicitationCount = 0;
let resumed = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake-codex/1.0" } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thr-" + process.pid } } });
    send({ method: "thread/started", params: { thread: { id: "thr-" + process.pid } } });
    return;
  }
  if (msg.method === "thread/resume") {
    resumed = true;
    const tid = msg.params?.threadId || "thr-" + process.pid;
    send({ id: msg.id, result: { thread: { id: tid } } });
    send({ method: "thread/started", params: { thread: { id: tid } } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    const turnId = activeTurn?.id || msg.params?.turnId;
    activeTurn = null;
    send({ id: msg.id, result: {} });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "interrupted" } } });
    return;
  }
  if (msg.method === "turn/start") {
    const prompt = (msg.params?.input || []).map((b) => b.text || "").join(" ");
    turns.push(prompt);
    const turnId = "turn-" + turns.length;
    activeTurn = { id: turnId, prompt };
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/started", params: { turn: { id: turnId, status: "inProgress" } } });

    if (mode === "elicitation") {
      send({
        id: 901,
        method: "mcpServer/elicitation/request",
        params: {
          serverName: "synthetic",
          threadId: msg.params.threadId,
          turnId,
          mode: "form",
          message: "Completa los parámetros del entorno",
          requestedSchema: {
            type: "object",
            properties: {
              entorno: { type: "string", enum: ["staging", "prod"] },
              reintentos: { type: "integer", minimum: 1, maximum: 5 },
              confirmar: { type: "boolean" },
              omitida: { type: "boolean", default: false },
            },
            required: ["entorno", "reintentos", "confirmar"],
            additionalProperties: false,
          },
        },
      });
      return;
    }

    if (mode === "reuse-id-disconnect" && !resumed && turns.length === 1) {
      send({
        id: 77,
        method: "item/tool/requestUserInput",
        params: {
          threadId: msg.params.threadId,
          turnId,
          itemId: "req-1",
          questions: [{ id: "q1", header: "Paso 1", question: "¿Sigues?", options: [{ label: "Si" }] }],
        },
      });
      setTimeout(() => process.exit(2), 30);
      return;
    }

    if (mode === "reuse-id-disconnect" && (resumed || turns.length >= 2)) {
      send({
        id: 77,
        method: "item/tool/requestUserInput",
        params: {
          threadId: msg.params.threadId,
          turnId,
          itemId: "req-2",
          questions: [{ id: "q2", header: "Paso 2", question: "¿Confirmas reconectado?", options: [{ label: "Si" }] }],
        },
      });
      return;
    }

    if (mode === "delayed-progress") {
      send({
        id: 501,
        method: "item/tool/requestUserInput",
        params: {
          threadId: msg.params.threadId,
          turnId,
          itemId: "req-progress",
          questions: [{ id: "q1", header: "Confirmar", question: "¿Avanzar?", options: [{ label: "Si" }] }],
        },
      });
      return;
    }

    if (prompt.includes("ESPERAR_INTERRUMPIR")) {
      send({ method: "item/agentMessage/delta", params: { delta: "Trabajando pid=" + process.pid } });
      activeTimer = setTimeout(() => {
        activeTurn = null;
        send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
      }, 15000);
      return;
    }

    const reply = "pid=" + process.pid + " turno=" + turns.length + " args=" + JSON.stringify(process.argv.slice(2)) + " prev=" + (turns.length > 1 ? turns[0] : "ninguno");
    send({ method: "item/agentMessage/delta", params: { delta: reply } });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
    return;
  }

  // Client responses to server-initiated requests
  if (Object.hasOwn(msg, "id") && msg.result !== undefined) {
    if (msg.id === 901) {
      elicitationCount += 1;
      const summary = "elicitation=" + JSON.stringify(msg.result);
      send({ method: "item/agentMessage/delta", params: { delta: summary } });
      send({ method: "turn/completed", params: { turn: { id: activeTurn?.id, status: "completed" } } });
      activeTurn = null;
      return;
    }
    if (msg.id === 77) {
      send({ method: "item/agentMessage/delta", params: { delta: "answered-77=" + JSON.stringify(msg.result) } });
      send({ method: "turn/completed", params: { turn: { id: activeTurn?.id, status: "completed" } } });
      activeTurn = null;
      return;
    }
    if (msg.id === 501) {
      // Wait for external trigger or slight delay so caller inspects "entregada" before progress
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { delta: "progreso-tras-respuesta=" + JSON.stringify(msg.result) } });
        send({ method: "turn/completed", params: { turn: { id: activeTurn?.id, status: "completed" } } });
        activeTurn = null;
      }, 120);
      return;
    }
  }
});
`;

export const FAKE_ACP_SCRIPT = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const prompts = [];
let activeId = null;
let activeTimer = null;
let selectedModel = "gemini-3.8-flash";
let selectedThought = "medium";
let lastMcpServers = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }
  if (msg.method === "authenticate") {
    send({ id: msg.id, result: { authenticated: true } });
    return;
  }
  if (msg.method === "session/new") {
    lastMcpServers = msg.params?.mcpServers ?? [];
    send({
      id: msg.id,
      result: {
        sessionId: "acp-" + process.pid,
        configOptions: [
          { id: "model", category: "model", currentValue: selectedModel },
          { id: "thought_level", category: "thought_level", currentValue: selectedThought },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/load") {
    lastMcpServers = msg.params?.mcpServers ?? [];
    send({
      id: msg.id,
      result: {
        sessionId: msg.params.sessionId,
        configOptions: [
          { id: "model", category: "model", currentValue: selectedModel },
          { id: "thought_level", category: "thought_level", currentValue: selectedThought },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    if (msg.params?.configId === "model") selectedModel = msg.params.value;
    if (msg.params?.configId === "thought_level") selectedThought = msg.params.value;
    send({
      id: msg.id,
      result: {
        configOptions: [
          { id: "model", category: "model", currentValue: selectedModel },
          { id: "thought_level", category: "thought_level", currentValue: selectedThought },
        ],
      },
    });
    return;
  }
  if (msg.method === "session/cancel") {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    const pendingId = activeId;
    activeId = null;
    if (pendingId !== null) {
      send({ id: pendingId, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (msg.method === "session/prompt") {
    const prompt = (msg.params?.prompt || []).map((b) => b.text || "").join(" ");
    prompts.push(prompt);
    if (prompt.includes("ESPERAR_INTERRUMPIR")) {
      activeId = msg.id;
      send({
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-esperando pid=" + process.pid } },
        },
      });
      activeTimer = setTimeout(() => {
        activeId = null;
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }, 15000);
      return;
    }
    const text = "acp pid=" + process.pid + " turno=" + prompts.length + " mcpCount=" + (lastMcpServers?.length ?? -1) + " args=" + JSON.stringify(process.argv.slice(2)) + " prev=" + (prompts.length > 1 ? prompts[0] : "ninguno");
    send({
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    });
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

export async function createHarness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-contracts-"));
  const dataDir = path.join(dir, "lanzador");
  const projectDir = path.join(dir, "proyecto");
  await writeFile(path.join(dir, "codex-fake.mjs"), FAKE_CODEX_SCRIPT);
  await writeFile(path.join(dir, "acp-fake.mjs"), FAKE_ACP_SCRIPT);

  const registry = await openSessionRegistry(
    path.join(dataDir, "sesiones.json"),
  );
  const toolCatalog = await createToolCatalogStore({ dataDir });
  if (options.emptyMcps) {
    await toolCatalog.updateProfile("ejecucion", { allowedMcps: [] });
  }
  const spawnedBinsAndArgs = [];

  function wrapScriptController(factory, scriptFile) {
    return () => {
      const ctrl = factory();
      return {
        ...ctrl,
        runTurn: (ctx) =>
          ctrl.runTurn({
            ...ctx,
            spawn: (bin, args, spawnEnv) => {
              const effectiveEnv = {
                ...spawnEnv,
                ...(options.env || {}),
              };
              spawnedBinsAndArgs.push({
                motor: ctx.session.motor,
                bin,
                args: [...args],
                env: effectiveEnv,
                mcpServers: ctx.mcpServers,
              });
              return ctx.spawn(
                process.execPath,
                [scriptFile, ...args],
                effectiveEnv,
              );
            },
          }),
      };
    };
  }

  const adapters = {
    codex: {
      createController: wrapScriptController(
        () => createCodexController(),
        path.join(dir, "codex-fake.mjs"),
      ),
    },
    agy: {
      createController: wrapScriptController(
        () => createAcpController(),
        path.join(dir, "acp-fake.mjs"),
      ),
    },
    ...(options.claudeControllerFactory
      ? { claude: { createController: options.claudeControllerFactory } }
      : {}),
  };

  const conversations = createProviderConversations({
    directory: path.join(dataDir, "conversaciones"),
    registro: registry,
    adapters,
    ...(options.rpcOverrides ? { rpc: options.rpcOverrides } : {}),
  });

  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: path.join(dir, ".codex-isolated"),
    SB_CODEX_BIN: process.execPath,
    SB_LANZADOR_DATA_DIR: dataDir,
    ...(options.env || {}),
  };

  const executor = createExecutor({
    registro: registry,
    proyectos: { demo: projectDir },
    env,
    maxActivos: options.maxActivos ?? 6,
    idleControllerMs: options.idleControllerMs ?? 0,
    conversations,
    toolCatalog,
    registrar: () => {},
  });

  await import("node:fs/promises").then((fs) =>
    fs.mkdir(projectDir, { recursive: true }),
  );
  t.after(async () => {
    await executor.cerrarTodo("Fin de prueba");
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 100,
    });
  });

  return {
    dir,
    dataDir,
    projectDir,
    registro: registry,
    conversations,
    toolCatalog,
    ejecutor: executor,
    env,
    spawnedBinsAndArgs,
  };
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Two full turns through service and launcher; a busy CI runner needs the margin.
export const E2E_TIMEOUT_MS = 15000;

export async function waitFor(predicate, timeoutMs = 4000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("Tiempo agotado esperando condición en prueba");
}

export function createStreamFakeProcess(onRpcMessage) {
  const child = new EventEmitter();
  child.pid = 90001;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let buf = "";
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onRpcMessage(JSON.parse(line), (payload) => {
          child.stdout.write(JSON.stringify(payload) + "\n");
        });
      }
      cb();
    },
  });
  child.kill = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end();
    child.emit("exit", 0, null);
  };
  return child;
}
