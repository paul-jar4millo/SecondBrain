// Controller for Claude Code through the Claude Agent SDK.
import { randomUUID } from "node:crypto";
import { LauncherError } from "../../errors.mjs";
import { IDENTIDAD_MARINA, validateEngineAttachments } from "../../engines.mjs";
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

/** @typedef {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} ClaudeUserMessage */
/** @typedef {import("@anthropic-ai/claude-agent-sdk").SDKMessage & { is_interrupt?: boolean }} ClaudeMessage */
/** @typedef {import("@anthropic-ai/claude-agent-sdk").Options} ClaudeOptions */
/** @typedef {import("@anthropic-ai/claude-agent-sdk").SlashCommand} ClaudeSlashCommand */
/**
 * @typedef {AsyncIterable<ClaudeMessage, void, unknown> &
 *   Partial<Pick<import("@anthropic-ai/claude-agent-sdk").Query, "interrupt" | "close">> & {
 *     supportedCommands?: () => Promise<(ClaudeSlashCommand | string)[]>
 *   }} ClaudeStream
 */
/** @typedef {(params: { prompt: AsyncIterable<ClaudeUserMessage>, options: ClaudeOptions }) => ClaudeStream} ClaudeQuery */
/**
 * @typedef {import("./controller-types.mjs").ProviderTurnContext & {
 *   nextId(): number,
 *   settingSources?: import("@anthropic-ai/claude-agent-sdk").SettingSource[],
 *   verifiedBillingGrant?: boolean
 * }} ClaudeContext
 */
/** @typedef {{ status: "completed" | "interrupted", pid?: number | null, persistent: boolean }} ClaudeTurnResult */
/**
 * @typedef {import("./controller-types.mjs").ProviderTurnState<ClaudeContext> & {
 *   toolCalls: Map<string, { id: string, name: string, input: unknown }>,
 *   killTimer: NodeJS.Timeout | null,
 *   aborted: boolean,
 *   resolve: (result: ClaudeTurnResult) => void,
 *   reject: (reason: unknown) => void
 * }} ClaudeTurn
 */

/**
 * Claude Code receives `content: null` on cancel/decline, as it always has;
 * the SDK's ElicitationResult type only lists an object or undefined.
 */
const NO_CONTENT = /** @type {undefined} */ (/** @type {unknown} */ (null));

function createInputQueue() {
  /** @type {ClaudeUserMessage[]} */
  const buffered = [];
  /** @type {((result: IteratorResult<ClaudeUserMessage, void>) => void)[]} */
  const waiters = [];
  let ended = false;
  return {
    /** @param {ClaudeUserMessage} msg */
    push(msg) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: msg, done: false });
      else buffered.push(msg);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
    isEnded: () => ended,
    /** @returns {AsyncIterator<ClaudeUserMessage, void, unknown>} */
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffered.length > 0) {
            return Promise.resolve({
              value: /** @type {ClaudeUserMessage} */ (buffered.shift()),
              done: false,
            });
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

/** @param {ClaudeQuery | null} [queryOverride] */
export function createClaudeController(queryOverride = null) {
  const connectionId = randomUUID();
  /** @type {ClaudeStream | null} */
  let stream = null;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let childProc = null;
  /** @type {ReturnType<typeof createInputQueue> | null} */
  let inputQueue = null;
  /** @type {ClaudeTurn | null} */
  let activeTurn = null;
  let closing = false;
  let pumpDead = false;
  let pumpStarted = false;
  /** @type {Promise<void> | null} */
  let connectPromise = null;
  let motor = "claude";
  const createdAt = new Date().toISOString();
  let lastUsedAt = Date.now();

  const isAlive = () =>
    !closing && !pumpDead && Boolean(stream) && Boolean(!inputQueue?.isEnded());

  /**
   * @template {"resolve" | "reject"} Method
   * @param {ClaudeTurn} turn
   * @param {Method} method
   * @param {Parameters<ClaudeTurn[Method]>[0]} payload
   */
  const settleActiveTurn = (turn, method, payload) => {
    if (!turn || activeTurn !== turn || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.killTimer ?? undefined);
    activeTurn = null;
    turn[method](/** @type {ClaudeTurnResult} */ (payload));
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
              if (typeof block !== "string" && block.type === "tool_result") {
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
                    ].includes(shortName ?? "")
                  ) {
                    const input = /** @type {Record<string, unknown>} */ (
                      used.input
                    );
                    const candidate =
                      input?.file_path ||
                      input?.notebook_path ||
                      input?.path ||
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
                        }).catch(/** @returns {null} */ () => null),
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

  /** @param {ClaudeContext} ctx */
  async function startStream(ctx) {
    if (isAlive()) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      // The executor always sets the engine of the session it runs.
      motor = /** @type {string} */ (ctx.session.motor);
      pumpDead = false;
      pumpStarted = false;
      /** @type {ClaudeQuery} */
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

      /** @param {ClaudeTurn} turnRef */
      const buildSdkCallbackAck = (turnRef) => {
        /** @type {(value: { callbackReturned: boolean }) => void} */
        let resolveAck = () => {};
        /** @type {(reason?: unknown) => void} */
        let rejectAck = () => {};
        /** @type {Promise<{ callbackReturned: boolean }>} */
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
          mcpServers: /** @type {ClaudeOptions["mcpServers"]} */ (mcpServers),
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
            ? {
                effort: /** @type {ClaudeOptions["effort"]} */ (
                  ctx.session.esfuerzo
                ),
              }
            : {}),
          spawnClaudeCodeProcess: (options) => {
            childProc = trackChildExit(
              ctx.spawn(options.command, options.args, options.env),
            );
            // Spawned with piped stdio, so stdin/stdout are never null.
            return /** @type {import("@anthropic-ai/claude-agent-sdk").SpawnedProcess} */ (
              /** @type {unknown} */ (childProc)
            );
          },
          onElicitation: async (request) => {
            const turn = activeTurn;
            if (!turn || turn.settled || turn.connectionId !== connectionId) {
              return { action: "cancel", content: NO_CONTENT };
            }
            const mode = request?.mode || "form";
            if (mode !== "form") {
              throw new LauncherError(
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
                /** @type {import("@anthropic-ai/claude-agent-sdk").ElicitationResult} */
                const payload = {
                  action: answer.decision === "decline" ? "decline" : "cancel",
                  content: NO_CONTENT,
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
              /** @type {import("@anthropic-ai/claude-agent-sdk").ElicitationResult} */
              const payload = {
                action: "accept",
                content:
                  /** @type {import("@anthropic-ai/claude-agent-sdk").ElicitationResult["content"]} */ (
                    validatedContent
                  ),
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
            const legacyOptions = /** @type {{ toolUseId?: string }} */ (
              options
            );
            const id =
              options.toolUseID ||
              legacyOptions.toolUseId ||
              `tool-${turn.ctx.nextId()}`;
            const { callbackAck, rejectAck, scheduleAfterReturn } =
              buildSdkCallbackAck(turn);
            try {
              if (name === "AskUserQuestion") {
                const questionInput =
                  /** @type {Record<string, unknown> & import("@anthropic-ai/claude-agent-sdk/sdk-tools").AskUserQuestionInput} */ (
                    input
                  );
                const answers = await turn.ctx.ask(
                  id,
                  {
                    kind: "question",
                    title: "Necesito tu respuesta",
                    questions: questionInput.questions.map((q) => ({
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
                /** @type {import("@anthropic-ai/claude-agent-sdk").PermissionResult} */
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
              /** @type {import("@anthropic-ai/claude-agent-sdk").PermissionResult} */
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

  /** @param {ClaudeContext} ctx */
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
    validateEngineAttachments(
      /** @type {string} */ (ctx.session.motor),
      ctx.attachments || [],
      /** @type {string} */ (ctx.cwd),
    );
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
            names: cmds
              .map(
                (c) =>
                  /** @type {string} */ (
                    /** @type {ClaudeSlashCommand} */ (c)?.name || c
                  ),
              )
              .filter(Boolean),
          });
        }
      } catch {
        /* mock or stream may not expose supportedCommands */
      }
    }

    // Both are replaced synchronously by the Promise executor below.
    /** @type {ClaudeTurn["resolve"]} */
    let resolveTurn = () => {};
    /** @type {ClaudeTurn["reject"]} */
    let rejectTurn = () => {};
    /** @type {Promise<ClaudeTurnResult>} */
    const completed = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    completed.catch(() => {});

    /** @type {ClaudeTurn} */
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

    if (!inputQueue) throw new Error("Claude no está conectado.");
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
