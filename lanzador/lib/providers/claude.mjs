// Controller for Claude Code through the Claude Agent SDK.
import { randomUUID } from "node:crypto";
import { ErrorLanzador } from "../../errores.mjs";
import { IDENTIDAD_MARINA, validarAdjuntosMotor } from "../../motores.mjs";
import {
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "./elicitation.mjs";
import {
  profileDisallowsAction,
  publishVerifiedWorkspaceArtifact,
  resolveMcpServers,
  text,
  trackChildExit,
  waitChildExit,
} from "./shared.mjs";

function createInputQueue() {
  const buffered = [];
  const waiters = [];
  let ended = false;
  return {
    push(msg) {
      if (ended) return;
      if (waiters.length > 0) {
        waiters.shift()({ value: msg, done: false });
      } else {
        buffered.push(msg);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()({ value: undefined, done: true });
      }
    },
    isEnded: () => ended,
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          ended = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export function createClaudeController(queryOverride = null) {
  const connectionId = randomUUID();
  let stream = null;
  let controller = null;
  let childProc = null;
  let inputQueue = null;
  let activeTurn = null;
  let closing = false;
  let pumpDead = false;
  let pumpStarted = false;
  let connectPromise = null;
  let motor = "claude";
  const createdAt = new Date().toISOString();
  let lastUsedAt = Date.now();

  const isAlive = () =>
    !closing && !pumpDead && Boolean(stream) && Boolean(!inputQueue?.isEnded());

  const settleActiveTurn = (turn, method, payload) => {
    if (!turn || activeTurn !== turn || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.killTimer);
    activeTurn = null;
    turn[method](payload);
  };

  function ensurePumpStarted() {
    if (pumpStarted || !stream) return;
    pumpStarted = true;
    void (async () => {
      let observedSessionId = null;
      try {
        for await (const event of stream) {
          const turn = activeTurn;
          if (!turn || turn.settled || turn.connectionId !== connectionId) {
            continue;
          }
          if (event.session_id) {
            if (!observedSessionId) observedSessionId = event.session_id;
            else if (event.session_id !== observedSessionId) continue;
            await turn.ctx.nativeId(event.session_id);
          }
          if (event.type === "assistant") {
            for (const [index, block] of (
              event.message?.content || []
            ).entries()) {
              if (block.type === "text") {
                turn.ctx.message(`${event.uuid}:text:${index}`, block.text);
              }
              if (block.type === "tool_use") {
                turn.toolCalls.set(block.id, {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
                turn.ctx.tool(block.id, {
                  nombre: block.name,
                  resumen: text(block.input),
                  estado: "pendiente",
                });
              }
            }
          }
          if (event.type === "user") {
            for (const block of event.message?.content || []) {
              if (block.type === "tool_result") {
                turn.ctx.tool(block.tool_use_id, {
                  resultado: text(block.content),
                  estado: block.is_error ? "error" : "ok",
                });
                if (!block.is_error) {
                  const used = turn.toolCalls.get(block.tool_use_id);
                  const shortName = String(used?.name || "")
                    .split("__")
                    .pop();
                  if (
                    used &&
                    [
                      "Write",
                      "Edit",
                      "MultiEdit",
                      "NotebookEdit",
                      "synth_artifact_write",
                    ].includes(shortName)
                  ) {
                    const candidate =
                      used.input?.file_path ||
                      used.input?.notebook_path ||
                      used.input?.path ||
                      null;
                    if (candidate) {
                      turn.pendingWork.push(
                        publishVerifiedWorkspaceArtifact({
                          ctx: turn.ctx,
                          cwd: turn.ctx.cwd,
                          rawPath: candidate,
                          evidenceRefs: [String(block.tool_use_id)],
                          comment: `Herramienta ${used.name}`,
                          publishedKeys: turn.publishedArtifactKeys,
                        }).catch(() => null),
                      );
                    }
                  }
                }
              }
            }
          }
          if (
            event.type === "stream_event" &&
            event.event?.type === "content_block_delta" &&
            event.event.delta?.type === "text_delta"
          ) {
            turn.ctx.delta(
              `stream:${event.parent_tool_use_id || "main"}:${event.event.index}`,
              event.event.delta.text,
              true,
            );
          }
          if (event.type === "result") {
            await Promise.allSettled(turn.pendingWork);
            if (activeTurn !== turn || turn.settled) continue;
            if (turn.aborted || event.is_interrupt) {
              settleActiveTurn(turn, "resolve", {
                status: "interrupted",
                pid: childProc?.pid ?? null,
                persistent: isAlive(),
              });
            } else if (event.is_error) {
              settleActiveTurn(
                turn,
                "reject",
                new Error("El proveedor no completó el turno"),
              );
            } else {
              settleActiveTurn(turn, "resolve", {
                status: "completed",
                pid: childProc?.pid ?? null,
                persistent: isAlive(),
              });
            }
          }
        }
        pumpDead = true;
        if (activeTurn && !activeTurn.settled) {
          const staleTurn = activeTurn;
          await Promise.allSettled(staleTurn.pendingWork);
          settleActiveTurn(
            staleTurn,
            staleTurn.aborted ? "resolve" : "reject",
            staleTurn.aborted
              ? { status: "interrupted", persistent: false }
              : new Error("El proveedor cerró sin confirmar el resultado"),
          );
        }
      } catch (err) {
        pumpDead = true;
        activeTurn?.ctx?.invalidateConnection?.(connectionId, err?.message);
        if (activeTurn && !activeTurn.settled) {
          const staleTurn = activeTurn;
          await Promise.allSettled(staleTurn.pendingWork);
          settleActiveTurn(
            staleTurn,
            staleTurn.aborted ? "resolve" : "reject",
            staleTurn.aborted
              ? { status: "interrupted", persistent: false }
              : err,
          );
        }
      }
    })();
  }

  async function startStream(ctx) {
    if (isAlive()) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      motor = ctx.session.motor;
      pumpDead = false;
      pumpStarted = false;
      const query =
        queryOverride || (await import("@anthropic-ai/claude-agent-sdk")).query;
      controller = new AbortController();
      inputQueue = createInputQueue();
      const mcpServers = resolveMcpServers(ctx);
      const envWithIsolation = {
        ...(ctx.env || {}),
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      };
      const disallowedTools = [];
      if (profileDisallowsAction(ctx, "write")) {
        disallowedTools.push("Write", "Edit", "MultiEdit", "NotebookEdit");
      }
      if (profileDisallowsAction(ctx, "shell")) {
        disallowedTools.push("Bash", "PowerShell");
      }
      if (profileDisallowsAction(ctx, "web")) {
        disallowedTools.push("WebFetch", "WebSearch");
      }

      const buildSdkCallbackAck = (turnRef) => {
        /** @type {(value?: unknown) => void} */
        let resolveAck = () => {};
        /** @type {(reason?: unknown) => void} */
        let rejectAck = () => {};
        const callbackAck = new Promise((r, j) => {
          resolveAck = r;
          rejectAck = j;
        });
        callbackAck.catch(() => {});
        const scheduleAfterReturn = () => {
          queueMicrotask(() => {
            if (
              closing ||
              pumpDead ||
              !isAlive() ||
              activeTurn !== turnRef ||
              turnRef.settled ||
              turnRef.connectionId !== connectionId
            ) {
              rejectAck(
                new Error(
                  "La conexión o turno de Claude cerró tras retornar el callback antes de observar envío.",
                ),
              );
              return;
            }
            resolveAck({ callbackReturned: true });
          });
        };
        return { callbackAck, rejectAck, scheduleAfterReturn };
      };

      stream = query({
        prompt: inputQueue,
        options: {
          cwd: ctx.cwd,
          env: envWithIsolation,
          abortController: controller,
          settingSources: ctx.settingSources ?? [],
          strictMcpConfig: true,
          mcpServersDelivery: "initialize",
          mcpServers,
          ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
          permissionMode: "default",
          includePartialMessages: true,
          ...(ctx.session.conversacionId
            ? { resume: ctx.session.conversacionId }
            : {}),
          ...(ctx.session.motor === "deepseek"
            ? {
                systemPrompt: {
                  type: "preset",
                  preset: "claude_code",
                  append: IDENTIDAD_MARINA,
                },
              }
            : {}),
          ...(ctx.session.modelo && ctx.session.motor !== "deepseek"
            ? { model: ctx.session.modelo }
            : {}),
          ...(ctx.session.esfuerzo && ctx.session.motor !== "deepseek"
            ? { effort: ctx.session.esfuerzo }
            : {}),
          spawnClaudeCodeProcess: (options) => {
            childProc = trackChildExit(
              ctx.spawn(options.command, options.args, options.env),
            );
            return childProc;
          },
          onElicitation: async (request) => {
            const turn = activeTurn;
            if (!turn || turn.settled || turn.connectionId !== connectionId) {
              return { action: "cancel", content: null };
            }
            const mode = request?.mode || "form";
            if (mode !== "form") {
              throw new ErrorLanzador(
                `Modo de elicitación no soportado: "${mode}".`,
                400,
              );
            }
            if (request?.requestedSchema) {
              validateRequestedSchema(request.requestedSchema);
            }
            const id = `elicitation-${turn.ctx.nextId()}`;
            const { callbackAck, rejectAck, scheduleAfterReturn } =
              buildSdkCallbackAck(turn);
            try {
              const answer = await turn.ctx.ask(
                id,
                {
                  kind: "approval",
                  title:
                    request?.message ||
                    `Solicitud MCP de ${request?.serverName || "Claude MCP"}`,
                  detail: text(
                    request?.requestedSchema || request?.url || request,
                  ),
                  serverName: request?.serverName || null,
                  mode,
                  requestedSchema: request?.requestedSchema || null,
                  choices: ["accept", "decline", "cancel"],
                },
                {
                  connectionId,
                  transportMode: "sdk_callback_return",
                  transportObservable: false,
                  callbackAck,
                  isConnectionAlive: () =>
                    isAlive() && activeTurn === turn && !turn.settled,
                },
              );
              if (activeTurn !== turn || turn.settled || !isAlive()) {
                rejectAck(
                  new Error("Conexión o turno Claude cerrado antes de enviar"),
                );
                throw new Error("Conexión cerrada");
              }
              if (answer.decision !== "accept") {
                const payload = {
                  action: answer.decision === "decline" ? "decline" : "cancel",
                  content: null,
                };
                scheduleAfterReturn();
                return payload;
              }
              const validatedContent = validateAndExtractElicitationContent(
                request?.requestedSchema,
                answer.content,
                mode,
              );
              if (!isAlive() || activeTurn !== turn || turn.settled) {
                rejectAck(new Error("Conexión Claude cerrada antes de enviar"));
                throw new Error("Conexión cerrada");
              }
              const payload = {
                action: "accept",
                content: validatedContent,
              };
              scheduleAfterReturn();
              return payload;
            } catch (err) {
              rejectAck(err);
              throw err;
            }
          },
          canUseTool: async (name, input, options) => {
            const turn = activeTurn;
            if (!turn || turn.settled || turn.connectionId !== connectionId) {
              return { behavior: "deny", message: "Sin turno activo" };
            }
            const writeTool = [
              "Write",
              "Edit",
              "MultiEdit",
              "NotebookEdit",
            ].includes(name);
            const shellTool = ["Bash", "PowerShell"].includes(name);
            const webTool = ["WebFetch", "WebSearch"].includes(name);
            if (
              (writeTool && profileDisallowsAction(turn.ctx, "write")) ||
              (shellTool && profileDisallowsAction(turn.ctx, "shell")) ||
              (webTool && profileDisallowsAction(turn.ctx, "web"))
            ) {
              return {
                behavior: "deny",
                message: `Herramienta "${name}" no permitida por el perfil activo`,
              };
            }
            const id =
              options.toolUseID ||
              options.toolUseId ||
              `tool-${turn.ctx.nextId()}`;
            const { callbackAck, rejectAck, scheduleAfterReturn } =
              buildSdkCallbackAck(turn);
            try {
              if (name === "AskUserQuestion") {
                const answers = await turn.ctx.ask(
                  id,
                  {
                    kind: "question",
                    title: "Necesito tu respuesta",
                    questions: input.questions.map((q) => ({
                      ...q,
                      id: q.question,
                      options: q.options || [],
                    })),
                  },
                  {
                    connectionId,
                    transportMode: "sdk_callback_return",
                    transportObservable: false,
                    callbackAck,
                    isConnectionAlive: () =>
                      isAlive() && activeTurn === turn && !turn.settled,
                  },
                );
                if (!isAlive() || activeTurn !== turn || turn.settled) {
                  rejectAck(
                    new Error("Conexión Claude cerrada antes de enviar"),
                  );
                  throw new Error("Conexión cerrada");
                }
                const payload = {
                  behavior: "allow",
                  updatedInput: { ...input, answers },
                };
                scheduleAfterReturn();
                return payload;
              }
              const answer = await turn.ctx.ask(
                id,
                {
                  kind: "approval",
                  title: `Permitir ${name}`,
                  detail: text(input),
                  choices: ["accept", "decline"],
                },
                {
                  connectionId,
                  transportMode: "sdk_callback_return",
                  transportObservable: false,
                  callbackAck,
                  isConnectionAlive: () =>
                    isAlive() && activeTurn === turn && !turn.settled,
                },
              );
              if (!isAlive() || activeTurn !== turn || turn.settled) {
                rejectAck(new Error("Conexión Claude cerrada antes de enviar"));
                throw new Error("Conexión cerrada");
              }
              const payload =
                answer.decision === "accept"
                  ? { behavior: "allow", updatedInput: input }
                  : {
                      behavior: "deny",
                      message: "Acción rechazada por el usuario",
                    };
              scheduleAfterReturn();
              return payload;
            } catch (err) {
              rejectAck(err);
              throw err;
            }
          },
        },
      });
    })();
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function runTurn(ctx) {
    lastUsedAt = Date.now();
    if (
      ctx.session.motor === "deepseek" &&
      ctx.verifiedBillingGrant !== true &&
      ctx.operatorEnv?.SB_ALLOW_BILLED_DEEPSEEK !== "1"
    ) {
      throw new Error(
        "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto. Usa un motor de suscripción o autoriza la ruta facturada.",
      );
    }
    validarAdjuntosMotor(ctx.session.motor, ctx.attachments || [], ctx.cwd);
    await startStream(ctx);
    if (
      ctx.onSkillsObserved &&
      typeof stream?.supportedCommands === "function"
    ) {
      try {
        const cmds = await stream.supportedCommands();
        if (Array.isArray(cmds)) {
          await ctx.onSkillsObserved({
            source: "claude_supported_commands",
            names: cmds.map((c) => c?.name || c).filter(Boolean),
          });
        }
      } catch {
        /* mock or stream may not expose supportedCommands */
      }
    }

    let resolveTurn;
    let rejectTurn;
    const completed = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    completed.catch(() => {});

    const turn = {
      ctx,
      connectionId,
      toolCalls: new Map(),
      pendingWork: [],
      publishedArtifactKeys: new Set(),
      aborted: false,
      settled: false,
      killTimer: null,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    activeTurn = turn;

    ctx.onAbort(() => {
      if (activeTurn !== turn || turn.settled) return;
      turn.aborted = true;
      if (typeof stream?.interrupt === "function") {
        void stream.interrupt().catch(() => controller?.abort());
        turn.killTimer = setTimeout(() => {
          if (activeTurn === turn && !turn.settled) {
            void shutdown("Timeout interrumpiendo turno Claude");
          }
        }, ctx.interruptKillGraceMs ?? 2500);
        turn.killTimer.unref?.();
      } else {
        controller?.abort();
      }
    });

    ctx.onControl?.({
      supportsSteer: false,
      connectionId,
      pid: childProc?.pid ?? null,
    });

    inputQueue.push({
      type: "user",
      message: {
        role: "user",
        content: ctx.prompt,
      },
      parent_tool_use_id: null,
    });
    ensurePumpStarted();

    const outcome = await completed;
    lastUsedAt = Date.now();
    return outcome;
  }

  async function shutdown(reason = "Cierre explícito") {
    closing = true;
    inputQueue?.end();
    if (activeTurn && !activeTurn.settled) {
      settleActiveTurn(activeTurn, "reject", new Error(reason));
    }
    controller?.abort();
    try {
      if (typeof stream?.close === "function") stream.close();
      else await stream?.[Symbol.asyncIterator]?.()?.return?.();
    } catch {}
    if (childProc) {
      try {
        childProc.kill("SIGTERM");
      } catch {}
      await waitChildExit(childProc, 1000);
    }
    stream = null;
    childProc = null;
  }

  return {
    get motor() {
      return motor;
    },
    connectionId,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    pid: () => (isAlive() ? (childProc?.pid ?? null) : null),
    isAlive,
    capabilities: () => ({
      persistentProcess: true,
      supportsSteer: false,
      supportsInterrupt: true,
      supportsResume: true,
      supportsElicitationForm: true,
      supportsUserInput: true,
    }),
    runTurn,
    interrupt: () => {
      const turn = activeTurn;
      if (!turn || turn.settled) return;
      turn.aborted = true;
      if (typeof stream?.interrupt === "function") {
        void stream.interrupt().catch(() => controller?.abort());
      } else {
        controller?.abort();
      }
    },
    shutdown,
  };
}
