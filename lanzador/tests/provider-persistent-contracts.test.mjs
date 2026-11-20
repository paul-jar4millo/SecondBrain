import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createApplication } from "../../service/index.mjs";
import { createToolCatalogStore } from "../catalogo-herramientas.mjs";
import { crearEjecutor } from "../ejecucion.mjs";
import { crearServidor } from "../index.mjs";
import {
  createAcpController,
  createClaudeController,
  createCodexController,
  parseCodexMcpServerKeys,
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "../provider-controllers.mjs";
import { createProviderConversations } from "../provider-conversations.mjs";
import { abrirRegistro } from "../sesiones.mjs";

const FAKE_CODEX_SCRIPT = `
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

const FAKE_ACP_SCRIPT = `
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

async function createHarness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-contracts-"));
  const dataDir = path.join(dir, "lanzador");
  const projectDir = path.join(dir, "proyecto");
  await writeFile(path.join(dir, "codex-fake.mjs"), FAKE_CODEX_SCRIPT);
  await writeFile(path.join(dir, "acp-fake.mjs"), FAKE_ACP_SCRIPT);

  const registro = await abrirRegistro(path.join(dataDir, "sesiones.json"));
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
    registro,
    adapters,
    ...(options.rpcOverrides ? { rpc: options.rpcOverrides } : {}),
  });

  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: path.join(dir, ".codex-isolated"),
    SB_LANZADOR_DATA_DIR: dataDir,
    ...(options.env || {}),
  };

  const ejecutor = crearEjecutor({
    registro,
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
    await ejecutor.cerrarTodo("Fin de prueba");
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
    registro,
    conversations,
    toolCatalog,
    ejecutor,
    env,
    spawnedBinsAndArgs,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Two full turns through service and launcher; a busy CI runner needs the margin.
const E2E_TIMEOUT_MS = 15000;

async function waitFor(predicate, timeoutMs = 4000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("Tiempo agotado esperando condición en prueba");
}

test("contrato 1: Codex, ACP y Claude mantienen un único PID en múltiples turnos + interrupción y liberan al cerrar/eliminar", async (t) => {
  let claudeQueryCalls = 0;
  let claudeInterruptCalls = 0;
  let claudeClosed = false;

  const h = await createHarness(t, {
    claudeControllerFactory: () =>
      createClaudeController(({ prompt }) => {
        claudeQueryCalls += 1;
        let closed = false;
        let waitInterrupt = null;
        let pushOut = null;
        const outQueue = [];
        const emit = (msg) => {
          if (pushOut) {
            const res = pushOut;
            pushOut = null;
            res({ value: msg, done: false });
          } else {
            outQueue.push(msg);
          }
        };
        void (async () => {
          let turnNum = 0;
          for await (const userMsg of prompt) {
            if (closed) break;
            turnNum += 1;
            const text = userMsg.message.content;
            if (turnNum === 1) {
              emit({ type: "system", subtype: "init", session_id: "cl-pid-1" });
            }
            if (text.includes("ESPERAR_INTERRUMPIR")) {
              emit({
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "claude trabajando" }],
                },
              });
              await new Promise((resolve) => {
                waitInterrupt = resolve;
              });
              emit({
                type: "result",
                subtype: "error_during_execution",
                is_interrupt: true,
                session_id: "cl-pid-1",
              });
            } else {
              emit({
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "text",
                      text: `claude-ok q=${claudeQueryCalls} turn=${turnNum}`,
                    },
                  ],
                },
              });
              emit({
                type: "result",
                subtype: "success",
                result: `claude-ok q=${claudeQueryCalls} turn=${turnNum}`,
                session_id: "cl-pid-1",
              });
            }
          }
          if (pushOut) {
            const res = pushOut;
            pushOut = null;
            res({ value: undefined, done: true });
          }
        })();
        return {
          async interrupt() {
            claudeInterruptCalls += 1;
            waitInterrupt?.();
            waitInterrupt = null;
          },
          close() {
            closed = true;
            claudeClosed = true;
            waitInterrupt?.();
          },
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (outQueue.length > 0) {
                  return Promise.resolve({
                    value: outQueue.shift(),
                    done: false,
                  });
                }
                if (closed)
                  return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                  pushOut = resolve;
                });
              },
              return() {
                closed = true;
                claudeClosed = true;
                waitInterrupt?.();
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      }),
  });

  // --- CODEX: 4 turns + interrupt in 1 OS PID ---
  const codexSess = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "codex-turno-uno",
    structured: true,
  });
  await h.ejecutor.esperar(codexSess.id);
  const afterT1 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT1.estado, "terminada");
  assert.equal(afterT1.conexion.estado, "ociosa");
  const codexPid1 = afterT1.conexion.pid;
  assert.ok(isPidAlive(codexPid1));
  assert.equal(h.ejecutor.activos(), 1);

  await h.ejecutor.continuar(codexSess.id, "codex-turno-dos");
  await h.ejecutor.esperar(codexSess.id);
  const afterT2 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT2.conexion.pid, codexPid1);
  assert.match(
    afterT2.resultado,
    new RegExp(`pid=${codexPid1} turno=2 .* prev=codex-turno-uno`),
  );

  await h.ejecutor.continuar(codexSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(codexSess.id)
      .then((s) => s.items.some((i) => i.texto?.includes("Trabajando pid="))),
  );
  await h.ejecutor.cancelar(codexSess.id);
  await h.ejecutor.esperar(codexSess.id);
  const afterT3 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT3.estado, "cancelada");
  assert.equal(afterT3.conexion.estado, "ociosa");
  assert.equal(afterT3.conexion.pid, codexPid1);
  assert.ok(isPidAlive(codexPid1));

  await h.ejecutor.continuar(codexSess.id, "codex-turno-cuatro");
  await h.ejecutor.esperar(codexSess.id);
  const afterT4 = h.registro.leer().find((s) => s.id === codexSess.id);
  assert.equal(afterT4.estado, "terminada");
  assert.match(afterT4.resultado, new RegExp(`pid=${codexPid1} turno=4`));
  assert.equal(
    h.spawnedBinsAndArgs.filter((x) => x.motor === "codex").length,
    1,
  );

  await h.ejecutor.cerrarConexion(codexSess.id, "Prueba cierre explícito");
  await waitFor(() => !isPidAlive(codexPid1));
  assert.equal(h.ejecutor.activos(), 0);
  await h.ejecutor.eliminar(codexSess.id);

  // --- ACP (agy): 4 turns + interrupt in 1 OS PID ---
  const acpSess = await h.ejecutor.encargar({
    motor: "agy",
    origen: "sala",
    proyecto: "demo",
    brief: "acp-turno-uno",
    modelo: "gemini-3.8-flash-medium",
    structured: true,
  });
  await h.ejecutor.esperar(acpSess.id);
  const acp1 = h.registro.leer().find((s) => s.id === acpSess.id);
  const acpPid1 = acp1.conexion.pid;
  assert.ok(isPidAlive(acpPid1));
  assert.equal(acp1.conexion.estado, "ociosa");

  await h.ejecutor.continuar(acpSess.id, "acp-turno-dos");
  await h.ejecutor.esperar(acpSess.id);
  const acp2 = h.registro.leer().find((s) => s.id === acpSess.id);
  assert.match(
    acp2.resultado,
    new RegExp(`acp pid=${acpPid1} turno=2 .* prev=acp-turno-uno`),
  );

  await h.ejecutor.continuar(acpSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(acpSess.id)
      .then((s) =>
        s.items.some((i) => i.texto?.includes("acp-esperando pid=")),
      ),
  );
  await h.ejecutor.cancelar(acpSess.id);
  await h.ejecutor.esperar(acpSess.id);
  assert.ok(isPidAlive(acpPid1));

  await h.ejecutor.continuar(acpSess.id, "acp-turno-cuatro");
  await h.ejecutor.esperar(acpSess.id);
  assert.match(
    h.registro.leer().find((s) => s.id === acpSess.id).resultado,
    new RegExp(`acp pid=${acpPid1} turno=4`),
  );
  assert.equal(h.spawnedBinsAndArgs.filter((x) => x.motor === "agy").length, 1);

  await h.ejecutor.eliminar(acpSess.id);
  await waitFor(() => !isPidAlive(acpPid1));
  assert.equal(h.ejecutor.activos(), 0);

  // --- CLAUDE SDK: 3 turns + interrupt reusing 1 streaming query ---
  const claudeSess = await h.ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    brief: "cl-1",
    structured: true,
  });
  await h.ejecutor.esperar(claudeSess.id);
  await h.ejecutor.continuar(claudeSess.id, "ESPERAR_INTERRUMPIR");
  await waitFor(() =>
    h.conversations
      .snapshot(claudeSess.id)
      .then((s) => s.items.some((i) => i.texto?.includes("claude trabajando"))),
  );
  await h.ejecutor.cancelar(claudeSess.id);
  await h.ejecutor.esperar(claudeSess.id);
  await h.ejecutor.continuar(claudeSess.id, "cl-3");
  await h.ejecutor.esperar(claudeSess.id);
  const cl3 = h.registro.leer().find((s) => s.id === claudeSess.id);
  assert.equal(cl3.resultado, "claude-ok q=1 turn=3");
  assert.equal(claudeQueryCalls, 1);
  assert.equal(claudeInterruptCalls, 1);
  await h.ejecutor.eliminar(claudeSess.id);
  assert.equal(claudeClosed, true);
  assert.equal(h.ejecutor.activos(), 0);
});

test("contrato 2: maxActivos cuenta procesos vivos ociosos, evicta con estado visible y reanuda sesión evictada; bloquea si ocupada", async (t) => {
  const h = await createHarness(t, { maxActivos: 1 });

  const s1 = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "primera",
    structured: true,
  });
  await h.ejecutor.esperar(s1.id);
  const s1Done = h.registro.leer().find((s) => s.id === s1.id);
  const pid1 = s1Done.conexion.pid;
  assert.equal(s1Done.estado, "terminada");
  assert.equal(h.ejecutor.activos(), 1);
  assert.ok(isPidAlive(pid1));

  // Starting s2 while s1 is idle MUST evict s1 cleanly without exceeding maxActivos=1
  const s2 = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "ESPERAR_INTERRUMPIR",
    structured: true,
  });
  await waitFor(() => !isPidAlive(pid1));
  const s1Evicted = h.registro.leer().find((s) => s.id === s1.id);
  assert.equal(s1Evicted.conexion.estado, "evictada");
  assert.match(s1Evicted.conexion.motivo, /límite/i);
  const s1Snap = await h.conversations.snapshot(s1.id);
  assert.equal(s1Snap.connection.status, "evicted");
  assert.equal(h.ejecutor.activos(), 1);

  // Wait until s2 is busy mid-turn; starting s3 MUST throw Límite de sesiones activas
  await waitFor(() =>
    h.conversations
      .snapshot(s2.id)
      .then((s) => s.items.some((i) => i.texto?.includes("Trabajando pid="))),
  );
  await assert.rejects(
    () =>
      h.ejecutor.encargar({
        motor: "codex",
        origen: "sala",
        proyecto: "demo",
        brief: "tercera-bloqueada",
        structured: true,
      }),
    /Límite de sesiones activas/,
  );

  // Stop s2 cleanly and resume evicted s1 via thread/resume
  await h.ejecutor.cancelar(s2.id);
  await h.ejecutor.esperar(s2.id);
  const s2Pid = h.registro.leer().find((s) => s.id === s2.id).conexion.pid;
  await h.ejecutor.continuar(s1.id, "reanudar-evictada");
  await h.ejecutor.esperar(s1.id);
  await waitFor(() => !isPidAlive(s2Pid));
  const s1Resumed = h.registro.leer().find((s) => s.id === s1.id);
  assert.equal(s1Resumed.estado, "terminada");
  assert.notEqual(s1Resumed.conexion.pid, pid1);
  assert.match(s1Resumed.resultado, /reanudar-evictada|turno=1/);
  assert.equal(
    h.registro.leer().find((s) => s.id === s2.id).conexion.estado,
    "evictada",
  );

  // Auto-eviction on idle timeout
  const idleHarness = await createHarness(t, {
    maxActivos: 2,
    idleControllerMs: 50,
  });
  const si = await idleHarness.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "auto-evict",
    structured: true,
  });
  await idleHarness.ejecutor.esperar(si.id);
  const siPid = idleHarness.registro.leer().find((s) => s.id === si.id)
    .conexion.pid;
  assert.ok(isPidAlive(siPid));
  await waitFor(
    () =>
      !isPidAlive(siPid) &&
      idleHarness.ejecutor.activos() === 0 &&
      idleHarness.registro.leer().find((s) => s.id === si.id)?.conexion
        ?.estado === "evictada",
  );
  const siAfter = idleHarness.registro.leer().find((s) => s.id === si.id);
  assert.equal(siAfter.conexion.estado, "evictada");
  assert.match(siAfter.conexion.motivo, /inactividad/i);
});

test("contrato 3: reconexión reutilizando mismo JSON-RPC id invalida callback previo sin contaminar ni responder el nuevo", async (t) => {
  const h = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "reuse-id-disconnect" },
  });

  const s = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "turno-caida",
    structured: true,
  });

  const oldReq = await waitFor(async () => {
    const snap = await h.conversations.snapshot(s.id);
    return snap.requests.find((r) => r.status === "pending");
  });
  await h.ejecutor.esperar(s.id);

  // Turn 1 crashed mid-callback: product preserves question as pendiente, nativeCallbackStatus interrupted
  const afterCrash = await h.conversations.snapshot(s.id);
  const keptOld = afterCrash.requests.find((r) => r.id === oldReq.id);
  assert.equal(keptOld.productStatus, "pendiente");
  assert.equal(keptOld.nativeCallbackStatus, "interrupted");

  // Reconnect Turn 2 which ALSO sends JSON-RPC id=77
  await h.ejecutor.continuar(s.id, "turno-reconectado");
  const newReq = await waitFor(async () => {
    const snap = await h.conversations.snapshot(s.id);
    return snap.requests.find(
      (r) => r.id !== oldReq.id && r.nativeCallbackStatus === "open",
    );
  });

  // Attempting to answer oldReq.id MUST fail 409 without touching newReq's callback
  await assert.rejects(
    () =>
      h.conversations.answer(s.id, {
        requestId: oldReq.id,
        responseId: randomUUID(),
        answers: { q1: "Si" },
      }),
    (err) => err.status === 409,
  );

  // Now answering newReq resolves Turn 2 cleanly
  const receipt = await h.conversations.answer(s.id, {
    requestId: newReq.id,
    responseId: randomUUID(),
    answers: { q2: "Si" },
  });
  assert.equal(receipt.delivered, true);
  await h.ejecutor.esperar(s.id);
  const done = h.registro.leer().find((x) => x.id === s.id);
  assert.equal(done.estado, "terminada");
  assert.match(done.resultado, /answered-77=/);
});

test("contrato 4: error de escritura guarda respuesta y marca entrega_incierta (nunca delivered); progreso promueve a confirmada y doble respuesta no duplica", async (t) => {
  // Subcase A: delayed progress shows entregada -> confirmada ONLY on subsequent harness progress, and concurrent double answer
  const hProgress = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "delayed-progress" },
  });
  const sp = await hProgress.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "progreso",
    structured: true,
  });
  const reqP = await waitFor(async () => {
    const snap = await hProgress.conversations.snapshot(sp.id);
    return snap.requests.find((r) => r.status === "pending");
  });

  const r1 = randomUUID();
  const r2 = randomUUID();
  const [a1, a2] = await Promise.allSettled([
    hProgress.conversations.answer(sp.id, {
      requestId: reqP.id,
      responseId: r1,
      answers: { q1: "Si" },
    }),
    hProgress.conversations.answer(sp.id, {
      requestId: reqP.id,
      responseId: r2,
      answers: { q1: "No" },
    }),
  ]);
  const fulfilled = [a1, a2].filter((x) => x.status === "fulfilled");
  const rejected = [a1, a2].filter((x) => x.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.status, "entregada");
  assert.equal(fulfilled[0].value.delivered, true);

  // Immediately after RPC write flush (before fake CLI emits progress after 120ms), NOT yet confirmada!
  const beforeProgress = await hProgress.conversations.snapshot(sp.id);
  const reqBefore = beforeProgress.requests.find((r) => r.id === reqP.id);
  assert.equal(reqBefore.productStatus, "entregada");

  // Idempotent retry on same responseId returns stored receipt
  const retryReceipt = await hProgress.conversations.answer(sp.id, {
    requestId: reqP.id,
    responseId: fulfilled[0].value.responseId,
    answers: { q1: "Si" },
  });
  assert.equal(retryReceipt.responseId, fulfilled[0].value.responseId);
  assert.equal(retryReceipt.status, "entregada");

  await hProgress.ejecutor.esperar(sp.id);
  const afterProgress = await hProgress.conversations.snapshot(sp.id);
  const reqAfter = afterProgress.requests.find((r) => r.id === reqP.id);
  assert.equal(reqAfter.productStatus, "confirmada");
  assert.equal(afterProgress.receipts.length, 1);
  assert.ok(afterProgress.receipts[0].harnessConfirmedAt);

  // Subcase B: write failure preserves saved answer with entrega_incierta (delivered: false)
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-write-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessId = randomUUID();
  const reg = await abrirRegistro(path.join(dir, "s.json"));
  await reg.crear({
    id: sessId,
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    encargo: "x",
    structured: true,
  });
  const conv = createProviderConversations({
    directory: path.join(dir, "conv"),
    registro: reg,
    adapters: {
      codex: async (ctx) => {
        await ctx.nativeId("t-fail");
        const writeAck = Promise.reject(new Error("EPIPE roto"));
        writeAck.catch(() => {});
        await ctx.ask(
          randomUUID(),
          {
            kind: "question",
            header: "P",
            prompt: "¿Continuar?",
            questions: [
              {
                id: "P",
                header: "P",
                prompt: "¿Continuar?",
                options: [{ id: "si", label: "Si" }],
              },
            ],
          },
          {
            writeAck,
          },
        );
      },
    },
  });
  let _askPromise;
  const runDone = conv.run({
    session: { id: sessId, motor: "codex", structured: true },
    prompt: "hola",
    cwd: dir,
    onNativeId: () => {},
  });
  const reqFail = await waitFor(async () => {
    const snap = await conv.snapshot(sessId);
    return snap.requests.find((r) => r.status === "pending");
  });
  const receiptFail = await conv.answer(sessId, {
    requestId: reqFail.id,
    responseId: randomUUID(),
    answers: { P: "Si" },
  });
  assert.equal(receiptFail.status, "entrega_incierta");
  assert.equal(receiptFail.delivered, false);
  const snapFail = await conv.snapshot(sessId);
  assert.deepEqual(snapFail.requests[0].answer.answers, { P: "Si" });
  assert.equal(snapFail.requests[0].productStatus, "entrega_incierta");
  await runDone.catch(() => {});
});

test("contrato 5: formulario content completo sin fabricar defaults + rechazos estrictos + validación HTTP lanzador", async (t) => {
  // Unit schema checks
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {},
      ),
    (err) => err.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        {
          type: "object",
          properties: { b: { type: "object", properties: {} } },
        },
        {},
      ),
    (err) => err.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        { type: "object", properties: { a: { type: "string" } } },
        { a: "x" },
        "url",
      ),
    (err) => err.status === 400,
  );

  // Full elicitation roundtrip via Codex & real launcher HTTP endpoint + Claude onElicitation
  const h = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "elicitation" },
    claudeControllerFactory: () =>
      createClaudeController(({ prompt, options }) => {
        let resolveDone;
        const done = new Promise((r) => {
          resolveDone = r;
        });
        return {
          async interrupt() {},
          [Symbol.asyncIterator]() {
            let step = 0;
            return {
              async next() {
                if (step === 0) {
                  step = 1;
                  const iter = prompt[Symbol.asyncIterator]();
                  await iter.next();
                  const elicitResult = await options.onElicitation({
                    serverName: "synthetic",
                    mode: "form",
                    message: "Formulario Claude",
                    requestedSchema: {
                      type: "object",
                      properties: {
                        confirmar: { type: "boolean" },
                        etiqueta: { type: "string" },
                        noEnviado: { type: "boolean", default: false },
                      },
                      required: ["confirmar", "etiqueta"],
                    },
                  });
                  return {
                    value: {
                      type: "assistant",
                      message: {
                        content: [
                          {
                            type: "text",
                            text: `cl-elicit=${JSON.stringify(elicitResult)}`,
                          },
                        ],
                      },
                      session_id: "cl-elicit-1",
                    },
                    done: false,
                  };
                }
                if (step === 1) {
                  step = 2;
                  return {
                    value: {
                      type: "result",
                      subtype: "success",
                      result: "ok",
                      session_id: "cl-elicit-1",
                    },
                    done: false,
                  };
                }
                if (step === 2) {
                  step = 3;
                  resolveDone();
                  return { value: undefined, done: true };
                }
                await done;
                return { value: undefined, done: true };
              },
              return() {
                resolveDone();
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      }),
  });

  const controlToken = "control-secret";
  const hookToken = "hook-secret";
  const launcher = crearServidor({
    registro: h.registro,
    ejecutor: h.ejecutor,
    conversations: h.conversations,
    toolCatalog: h.toolCatalog,
    catalogo: { modelos: async () => ({}), validar: async () => true },
    uso: async () => ({}),
    items: () => [],
    acciones: null,
    equipos: null,
    proyectos: { demo: h.projectDir },
    espacios: null,
    controlHash: createHash("sha256").update(controlToken).digest("hex"),
    hookHash: createHash("sha256").update(hookToken).digest("hex"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => {
    launcher.closeAllConnections?.();
    launcher.close();
  });
  const base = `http://127.0.0.1:${launcher.address().port}`;
  const hdrs = {
    "content-type": "application/json",
    authorization: `Bearer ${controlToken}`,
  };

  // Test Codex elicitation through HTTP
  const sx = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "form-codex",
    structured: true,
  });
  const reqC = await waitFor(async () => {
    const snap = await h.conversations.snapshot(sx.id);
    return snap.requests.find((r) => r.status === "pending");
  });

  // Missing required field -> 400
  const badRes = await fetch(`${base}/sesiones/${sx.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqC.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { entorno: "staging", reintentos: 2 },
    }),
  });
  assert.equal(badRes.status, 400);

  // Valid form omitting optional boolean `omitida` -> NOT fabricated to false!
  const goodRes = await fetch(`${base}/sesiones/${sx.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqC.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { entorno: "staging", reintentos: 2, confirmar: false },
    }),
  });
  assert.equal(goodRes.status, 200);
  await h.ejecutor.esperar(sx.id);
  const doneCodex = h.registro.leer().find((r) => r.id === sx.id);
  const parsedCodex = JSON.parse(
    doneCodex.resultado.replace("elicitation=", ""),
  );
  assert.deepEqual(parsedCodex, {
    action: "accept",
    content: { entorno: "staging", reintentos: 2, confirmar: false },
    _meta: null,
  });
  assert.equal(Object.hasOwn(parsedCodex.content, "omitida"), false);

  // Test Claude onElicitation preserving full content without fabricating defaults
  const sc = await h.ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    brief: "form-claude",
    structured: true,
  });
  const reqCl = await waitFor(async () => {
    const snap = await h.conversations.snapshot(sc.id);
    return snap.requests.find((r) => r.status === "pending");
  });
  const clRes = await fetch(`${base}/sesiones/${sc.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqCl.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { confirmar: true, etiqueta: "alta" },
    }),
  });
  assert.equal(clRes.status, 200);
  await h.ejecutor.esperar(sc.id);
  const doneClaude = h.registro.leer().find((r) => r.id === sc.id);
  const parsedClaude = JSON.parse(
    doneClaude.resultado.replace("cl-elicit=", ""),
  );
  assert.deepEqual(parsedClaude, {
    action: "accept",
    content: { confirmar: true, etiqueta: "alta" },
  });
  assert.equal(Object.hasOwn(parsedClaude.content, "noEnviado"), false);

  await h.ejecutor.cerrarConexion(sx.id);
});

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

function createStreamFakeProcess(onRpcMessage) {
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

test("regresión: Codex ignora turn-1 atrasado e hilo ajeno durante turno-2 y maneja carrera legítima turn/started; ACP aísla sesión y generación", async (t) => {
  const ctrl = createCodexController();
  t.after(() => ctrl.shutdown("fin"));

  let turnCallCount = 0;
  let _sendFn = null;
  let askInvocations = 0;

  const makeCtx = (promptText, overrides = {}) => ({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "codex" },
    cwd: os.tmpdir(),
    prompt: promptText,
    attachments: [],
    mcpServers: {},
    env: {},
    operatorEnv: {},
    disableInheritedMcp: false,
    delta: (...args) => overrides.deltas?.push(args),
    message: (...args) => overrides.messages?.push(args),
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => {
      askInvocations += 1;
      return { decision: "accept" };
    },
    spawn() {
      return createStreamFakeProcess((msg, send) => {
        _sendFn = send;
        if (msg.method === "initialize") {
          send({ id: msg.id, result: {} });
        } else if (msg.method === "thread/start") {
          send({ id: msg.id, result: { thread: { id: "thread-A" } } });
        } else if (msg.method === "turn/start") {
          turnCallCount += 1;
          if (turnCallCount === 1) {
            send({ id: msg.id, result: { turn: { id: "turn-1" } } });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-A",
                turn: { id: "turn-1", status: "completed" },
              },
            });
          } else if (turnCallCount === 2) {
            // Simulate stale turn-1 delayed events + foreign thread BEFORE turn/start response
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-A",
                turnId: "turn-1",
                itemId: "stale-1",
                delta: "STALE_DELTA",
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-A",
                turn: { id: "turn-1", status: "completed" },
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-B",
                turn: { id: "turn-9", status: "completed" },
              },
            });
            setTimeout(() => {
              // Respond turn/start with turn-2 AFTER stale turn-1 completion arrived
              send({ id: msg.id, result: { turn: { id: "turn-2" } } });
              // Stale callback from turn-1 during active turn-2 MUST be rejected (-32601)
              send({
                id: 7001,
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "thread-A",
                  turnId: "turn-1",
                  questions: [{ id: "q", question: "stale?" }],
                },
              });
              // Stale turn-1 completion again while turn-2 active
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-1", status: "completed" },
                },
              });
              send({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread-A",
                  turnId: "turn-2",
                  itemId: "ok-2",
                  delta: "REAL_TURN_2",
                },
              });
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-2", status: "completed" },
                },
              });
            }, 30);
          } else if (turnCallCount === 3) {
            // Legitimate race: turn/started + delta BEFORE rpc response for turn/start
            send({
              method: "turn/started",
              params: { threadId: "thread-A", turn: { id: "turn-race-3" } },
            });
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-A",
                turnId: "turn-race-3",
                itemId: "r-3",
                delta: "RACE_OK",
              },
            });
            setTimeout(() => {
              send({ id: msg.id, result: { turn: { id: "turn-race-3" } } });
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-race-3", status: "completed" },
                },
              });
            }, 20);
          }
        }
      });
    },
  });

  const t1Out = await ctrl.runTurn(makeCtx("uno"));
  assert.equal(t1Out.turnId, "turn-1");

  const d2 = [];
  const t2Out = await ctrl.runTurn(makeCtx("dos", { deltas: d2 }));
  assert.equal(t2Out.turnId, "turn-2");
  assert.equal(askInvocations, 0);
  assert.deepEqual(
    d2.map((x) => x[1]),
    ["REAL_TURN_2"],
  );

  const d3 = [];
  const t3Out = await ctrl.runTurn(makeCtx("tres", { deltas: d3 }));
  assert.equal(t3Out.turnId, "turn-race-3");
  assert.deepEqual(
    d3.map((x) => x[1]),
    ["RACE_OK"],
  );

  // ACP isolation: foreign sessionId updates ignored, orphan between prompts ignored
  const acpCtrl = createAcpController();
  t.after(() => acpCtrl.shutdown("fin"));
  let acpSend = null;
  const acpDeltas = [];
  await acpCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "agy" },
    cwd: os.tmpdir(),
    prompt: "acp-1",
    mcpServers: {},
    env: {},
    operatorEnv: { SB_AGY_ACP_ARGS: JSON.stringify(["acp-mock"]) },
    delta: (...a) => acpDeltas.push(a),
    message: () => {},
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
      return createStreamFakeProcess((msg, send) => {
        acpSend = send;
        if (msg.method === "initialize") {
          send({
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
          });
        } else if (msg.method === "session/new") {
          send({ id: msg.id, result: { sessionId: "acp-sess-1" } });
        } else if (msg.method === "session/prompt") {
          send({
            method: "session/update",
            params: {
              sessionId: "acp-sess-AJENA",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "AJENO" },
              },
            },
          });
          send({
            method: "session/update",
            params: {
              sessionId: "acp-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "MIO" },
              },
            },
          });
          send({ id: msg.id, result: { stopReason: "end_turn" } });
        }
      });
    },
  });
  assert.deepEqual(
    acpDeltas.map((x) => x[1]),
    ["MIO"],
  );
  // Stale update sent outside active prompt MUST NOT mutate anything
  acpSend({
    method: "session/update",
    params: {
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "TARDE" },
      },
    },
  });
  assert.deepEqual(
    acpDeltas.map((x) => x[1]),
    ["MIO"],
  );
});

test("regresión: Claude reporta callback_returned sin fingir rpc_write_flushed; fallo preserva respuesta en entrega_incierta; interrupt() público funciona", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-cl-ack-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  let mode = "success_delayed_progress";
  let releaseTurn = null;
  let capturedInterruptCount = 0;

  const registro = await abrirRegistro(path.join(dir, "ses.json"));
  const conv = createProviderConversations({
    directory: path.join(dir, "conv"),
    registro,
    adapters: {
      claude: {
        createController: () =>
          createClaudeController(({ prompt, options }) => ({
            async interrupt() {
              capturedInterruptCount += 1;
            },
            close() {},
            async *[Symbol.asyncIterator]() {
              const iter = prompt[Symbol.asyncIterator]();
              await iter.next();
              if (mode === "interrupt_only") {
                yield {
                  type: "system",
                  subtype: "init",
                  session_id: "cl-int-1",
                };
                await new Promise((r) => {
                  releaseTurn = r;
                });
                yield {
                  type: "result",
                  subtype: "error_during_execution",
                  is_interrupt: true,
                  session_id: "cl-int-1",
                };
                return;
              }
              await options.onElicitation({
                serverName: "synth",
                mode: "form",
                message: "Confirma",
                requestedSchema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                },
              });
              if (mode === "fail_before_progress") {
                // SDK fails right after receiving callback WITHOUT emitting assistant/result:success
                yield {
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  session_id: "cl-fail-1",
                };
                return;
              }
              await new Promise((r) => {
                releaseTurn = r;
              });
              yield {
                type: "assistant",
                uuid: "a1",
                message: { content: [{ type: "text", text: "progreso real" }] },
                session_id: "cl-ok-1",
              };
              yield {
                type: "result",
                subtype: "success",
                result: "progreso real",
                session_id: "cl-ok-1",
              };
            },
          })),
      },
    },
  });

  // Subcase A: callback returns -> status is "entregando" / callback_returned (NOT rpc_write_flushed or delivered=true), then promotes on progress
  const s1 = await registro.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    encargo: "a",
    structured: true,
  });
  const run1 = conv.run({
    session: s1,
    prompt: "p",
    cwd: dir,
    mcpServers: {},
    env: {},
    operatorEnv: {},
    spawn: () => {},
    onNativeId: () => {},
  });
  const req1 = await waitFor(async () =>
    (await conv.snapshot(s1.id)).requests.find((r) => r.status === "pending"),
  );
  const ackRes = await conv.answer(s1.id, {
    requestId: req1.id,
    responseId: randomUUID(),
    decision: "accept",
    content: { ok: true },
  });
  assert.equal(ackRes.status, "entregando");
  assert.equal(ackRes.callbackReturned, true);
  assert.equal(ackRes.delivered, false);
  assert.equal(ackRes.transportObservable, false);
  assert.equal(ackRes.transportEvidence, "callback_returned");
  assert.match(ackRes.transportLimit, /SDK/);
  releaseTurn?.();
  await run1;
  const snap1 = await conv.snapshot(s1.id);
  assert.equal(snap1.receipts[0].status, "confirmada");
  assert.equal(snap1.receipts[0].delivered, true);
  assert.equal(snap1.receipts[0].transportEvidence, "harness_progress");

  // Subcase B: SDK receives callback then fails before emitting progress -> reconciles to entrega_incierta keeping answer
  mode = "fail_before_progress";
  const s2 = await registro.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    encargo: "b",
    structured: true,
  });
  const run2 = conv
    .run({
      session: s2,
      prompt: "p",
      cwd: dir,
      mcpServers: {},
      env: {},
      operatorEnv: {},
      spawn: () => {},
      onNativeId: () => {},
    })
    .catch(() => null);
  const req2 = await waitFor(async () =>
    (await conv.snapshot(s2.id)).requests.find((r) => r.status === "pending"),
  );
  await conv.answer(s2.id, {
    requestId: req2.id,
    responseId: randomUUID(),
    decision: "accept",
    content: { ok: false },
  });
  await run2;
  const snap2 = await conv.snapshot(s2.id);
  assert.equal(snap2.receipts[0].status, "entrega_incierta");
  assert.equal(snap2.receipts[0].delivered, false);
  assert.deepEqual(snap2.requests[0].answer.content, { ok: false });

  // Subcase C (regression): direct controller.interrupt() works without ReferenceError
  mode = "interrupt_only";
  const directCtrl = createClaudeController(({ prompt }) => ({
    async interrupt() {
      capturedInterruptCount += 1;
      releaseTurn?.();
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      for await (const _ of prompt) {
        yield { type: "system", subtype: "init", session_id: "cl-int-1" };
        await new Promise((r) => {
          releaseTurn = r;
        });
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_interrupt: true,
          session_id: "cl-int-1",
        };
        break;
      }
    },
  }));
  const intTurn = directCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "claude" },
    cwd: dir,
    prompt: "espera",
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
    ask: async () => ({}),
    spawn: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  directCtrl.interrupt();
  const intRes = await intTurn;
  assert.equal(intRes.status, "interrupted");
  assert.ok(capturedInterruptCount >= 1);
  await directCtrl.shutdown();
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

test("regresión: validator aplica pattern, multipleOf, format, uniqueItems y rechaza keywords no soportados ANTES de pedir respuesta", () => {
  const patternSchema = {
    type: "object",
    properties: { x: { type: "string", pattern: "^SI$" } },
    required: ["x"],
  };
  assert.throws(
    () => validateAndExtractElicitationContent(patternSchema, { x: "NO" }),
    (e) => e.status === 400,
  );
  assert.deepEqual(
    validateAndExtractElicitationContent(patternSchema, { x: "SI" }),
    { x: "SI" },
  );

  const numSchema = {
    type: "object",
    properties: {
      paso: {
        type: "number",
        multipleOf: 0.1,
        exclusiveMinimum: 0,
        maximum: 1,
      },
      email: { type: "string", format: "email" },
      etiquetas: {
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      },
      opcional: { type: "boolean", default: false },
    },
    required: ["paso", "email"],
  };
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.35,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "invalido",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "a@b.co",
        etiquetas: ["a", "a"],
      }),
    (e) => e.status === 400,
  );
  const ok = validateAndExtractElicitationContent(numSchema, {
    paso: 0.3,
    email: "a@b.co",
    etiquetas: ["a", "b"],
  });
  assert.deepEqual(ok, { paso: 0.3, email: "a@b.co", etiquetas: ["a", "b"] });
  assert.equal(Object.hasOwn(ok, "opcional"), false);

  // Unsupported keywords rejected upfront in validateRequestedSchema (before asking user)
  for (const bad of [
    {
      type: "object",
      properties: { a: { type: "string" } },
      dependencies: { a: ["b"] },
    },
    { type: "object", properties: { a: { type: "string", customKeyword: 1 } } },
    {
      type: "object",
      properties: { a: { type: "string", format: "hostname" } },
    },
    {
      type: "object",
      properties: { a: { type: "string", pattern: "[invalido" } },
    },
    { type: "object", properties: { a: { type: "number", multipleOf: 0 } } },
  ]) {
    assert.throws(
      () => validateRequestedSchema(bad),
      (e) => e.status === 400,
    );
  }
});

test("regresión: publicación productiva ctx.artifact (2 versiones inmutables en misma ruta), bloqueo traversal/symlink/.env y descarga vía API service tras recarga", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sb-art-e2e-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  const vaultRoot = path.join(root, "vault");
  const serviceData = path.join(root, "service-data");
  const lanzadorData = path.join(root, "lanzador-data");
  const projDir = path.join(root, "proyecto");
  const outsideFile = path.join(root, "fuera.txt");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await mkdir(path.join(projDir, "informe"), { recursive: true });
  await writeFile(vaultRoot + "/Home.md", "# Vault sintético\n");
  await writeFile(outsideFile, "secreto fuera");
  await writeFile(path.join(projDir, ".env"), "SECRET=123\n");
  try {
    await symlink(outsideFile, path.join(projDir, "enlace-fuera.txt"));
  } catch {
    /* Windows without Developer Mode may disallow file symlinks; traversal + .env still verified */
  }

  let turnIdx = 0;
  // Turn 1 stays open until the next message is sent, so that message is
  // queued and runs as a follow-up turn: the race a fast agent creates.
  let releaseTurn1;
  const turn1Held = new Promise((r) => (releaseTurn1 = r));
  const registro = await abrirRegistro(
    path.join(lanzadorData, "sesiones.json"),
  );
  const toolCatalog = await createToolCatalogStore({ dataDir: lanzadorData });
  await toolCatalog.updateProfile("ejecucion", { allowedMcps: [] });

  const conversations = createProviderConversations({
    directory: path.join(lanzadorData, "conversations"),
    registro,
    adapters: {
      codex: {
        createController: () => {
          const inner = createCodexController();
          return {
            ...inner,
            runTurn: (ctx) =>
              inner.runTurn({
                ...ctx,
                spawn() {
                  return createStreamFakeProcess((msg, send) => {
                    if (msg.method === "initialize") {
                      send({ id: msg.id, result: {} });
                    } else if (msg.method === "thread/start") {
                      send({
                        id: msg.id,
                        result: { thread: { id: "th-art" } },
                      });
                    } else if (msg.method === "turn/start") {
                      turnIdx += 1;
                      const tid = `turn-art-${turnIdx}`;
                      send({ id: msg.id, result: { turn: { id: tid } } });
                      const targetFile = path.join(
                        projDir,
                        "informe",
                        "entrega.md",
                      );
                      const textContent =
                        turnIdx === 1
                          ? "Contenido version 1"
                          : "Contenido version 2 actualizado";
                      void writeFile(targetFile, textContent, "utf8").then(
                        () => {
                          send({
                            method: "item/completed",
                            params: {
                              threadId: "th-art",
                              turnId: tid,
                              item: {
                                type: "fileChange",
                                id: `fc-${turnIdx}`,
                                status: "completed",
                                changes: [
                                  { path: "../fuera.txt", kind: "update" },
                                  { path: ".env", kind: "update" },
                                  { path: "enlace-fuera.txt", kind: "update" },
                                  {
                                    path: "informe/entrega.md",
                                    kind: turnIdx === 1 ? "add" : "update",
                                  },
                                ],
                              },
                            },
                          });
                          send({
                            method: "item/completed",
                            params: {
                              threadId: "th-art",
                              turnId: tid,
                              item: {
                                type: "agentMessage",
                                id: `msg-${turnIdx}`,
                                text: `Publicado v${turnIdx}`,
                              },
                            },
                          });
                          const complete = () =>
                            send({
                              method: "turn/completed",
                              params: {
                                threadId: "th-art",
                                turn: { id: tid, status: "completed" },
                              },
                            });
                          if (tid === "turn-art-1")
                            void turn1Held.then(complete);
                          else complete();
                        },
                      );
                    }
                  });
                },
              }),
          };
        },
      },
    },
  });

  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: projDir },
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".cx"),
      SB_LANZADOR_DATA_DIR: lanzadorData,
    },
    conversations,
    toolCatalog,
    registrar: () => {},
  });

  const controlToken = "ctrl-token-art";
  const launcher = crearServidor({
    registro,
    ejecutor,
    conversations,
    toolCatalog,
    catalogo: { modelos: async () => ({}), validar: async () => true },
    uso: async () => ({}),
    items: () => [],
    acciones: null,
    equipos: null,
    proyectos: { demo: projDir },
    espacios: null,
    controlHash: createHash("sha256").update(controlToken).digest("hex"),
    hookHash: createHash("sha256").update("hook-token-art").digest("hex"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(async () => {
    await ejecutor.cerrarTodo("fin");
    launcher.closeAllConnections?.();
    await new Promise((r) => launcher.close(r));
  });

  const launcherUrl = `http://127.0.0.1:${launcher.address().port}`;
  let app = await createApplication({
    vaultRoot,
    dataDirectory: serviceData,
    auth: false,
    lanzador: { url: launcherUrl, token: controlToken },
  });
  t.after(() => app?.close?.());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let baseApi = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const getHeaders = async () => {
    const r = await fetch(`${baseApi}/auth/csrf`);
    const { token } = await r.json();
    return {
      "content-type": "application/json",
      "x-csrf-token": token,
      origin: baseApi.replace("/api/v1", ""),
      cookie: r.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  };

  let hdrs = await getHeaders();
  const woCreate = await fetch(`${baseApi}/encargos`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      title: "Prueba artefactos inmutables",
      objective: "Publicar dos versiones",
      acceptanceCriteria: [{ text: "Dos versiones" }],
      team: [
        {
          id: "coord-ambar",
          characterId: "ambar",
          engine: "claude",
          model: "claude-opus-4-7",
          effort: "high",
          role: "Coordinadora",
          responsibility: "Coordinar entrega",
          coordinator: true,
          toolProfileId: "coordinacion",
        },
        {
          id: "exec-menta",
          characterId: "menta",
          engine: "codex",
          model: "gpt-5.4",
          effort: "high",
          role: "Implementadora",
          responsibility: "Escribir entrega.md",
          coordinator: false,
          toolProfileId: "ejecucion",
        },
      ],
    }),
  });
  const woRes = await woCreate.json();
  assert.equal(woCreate.status, 201, JSON.stringify(woRes));
  const workOrderId = woRes.encargo.id;
  await fetch(`${baseApi}/encargos/iniciar`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ workOrderId }),
  });

  // Turn 1 publishes v1
  const sRes = await fetch(`${baseApi}/agentes/sesiones`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      motor: "codex",
      origen: "encargo",
      proyecto: "demo",
      brief: "Publicar v1",
      structured: true,
      workOrderId,
      memberId: "exec-menta",
      toolProfileId: "ejecucion",
    }),
  });
  assert.equal(sRes.status, 202);
  const sess = await sRes.json();

  await waitFor(async () => {
    const det = await fetch(
      `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
    ).then((r) => r.json());
    return det.snapshot.artifacts.length === 1;
  }, E2E_TIMEOUT_MS);

  // Turn 2 overwrites SAME path informe/entrega.md -> publishes v2
  const mRes = await fetch(`${baseApi}/agentes/conversacion/mensajes`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      id: sess.id,
      clientMessageId: randomUUID(),
      mode: "send",
      text: "Publicar v2 en misma ruta",
    }),
  });
  assert.equal(mRes.status, 200);
  assert.equal((await mRes.json()).queued, true);
  releaseTurn1();

  const detBeforeReload = await waitFor(async () => {
    const det = await fetch(
      `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
    ).then((r) => r.json());
    return det.snapshot.artifacts.length === 2 ? det : null;
  }, E2E_TIMEOUT_MS);
  assert.equal(
    detBeforeReload.events.filter((e) => e.type === "artifact.published")
      .length,
    2,
  );

  // Reload service cleanly -> artifacts & immutable v1/v2 API downloads MUST still return exact bytes!
  await app.close();
  app = await createApplication({
    vaultRoot,
    dataDirectory: serviceData,
    auth: false,
    lanzador: { url: launcherUrl, token: controlToken },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  baseApi = `http://127.0.0.1:${app.server.address().port}/api/v1`;

  const detReload = await fetch(
    `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
  ).then((r) => r.json());
  const [v1, v2] = detReload.snapshot.artifacts;
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.fileRef, "informe/entrega.md");
  assert.equal(v2.fileRef, "informe/entrega.md");
  assert.ok(v1.evidenceRefs.includes("fc-1"));
  assert.ok(v2.evidenceRefs.includes("fc-2"));
  assert.equal(
    v1.hash,
    createHash("sha256").update("Contenido version 1").digest("hex"),
  );
  assert.equal(
    v2.hash,
    createHash("sha256")
      .update("Contenido version 2 actualizado")
      .digest("hex"),
  );

  const dl1 = await fetch(
    `${baseApi}/encargos/artefactos/descargar?workOrderId=${workOrderId}&artifactId=${v1.id}`,
  );
  assert.equal(dl1.status, 200);
  assert.equal(dl1.headers.get("x-artifact-version"), "1");
  assert.equal(dl1.headers.get("x-artifact-sha256"), v1.hash);
  assert.equal(await dl1.text(), "Contenido version 1");

  const dl2 = await fetch(
    `${baseApi}/agentes/conversacion/artefactos/descargar?id=${sess.id}&artifactId=${v2.id}`,
  );
  assert.equal(dl2.status, 200);
  assert.equal(dl2.headers.get("x-artifact-version"), "2");
  assert.equal(dl2.headers.get("x-artifact-sha256"), v2.hash);
  assert.equal(await dl2.text(), "Contenido version 2 actualizado");
});
