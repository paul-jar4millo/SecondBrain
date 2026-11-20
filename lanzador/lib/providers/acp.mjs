// Controller for Agent Client Protocol (ACP) CLIs.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { validarAdjuntosMotor } from "../../motores.mjs";
import { providerRpc } from "../../provider-rpc.mjs";
import {
  exitedChildren,
  formatAcpInput,
  prepareAcpLaunchSpec,
  profileDisallowsAction,
  publishVerifiedWorkspaceArtifact,
  text,
  trackChildExit,
  verifyAcpConfigModel,
  waitChildExit,
} from "./shared.mjs";

/** @typedef {import("./controller-types.mjs").ProviderTurnContext & import("./shared.mjs").AcpLaunchContext} AcpContext */
/** @typedef {Partial<import("../../provider-rpc.mjs").RpcRequestMetadata>} RpcRequestMetadata */
/** @typedef {import("../../provider-rpc.mjs").RpcId} RpcId */
/** @typedef {import("../../provider-rpc.mjs").ProviderChild} ProviderChild */
/** @typedef {{ type?: string, text?: string, path?: string }} AcpContentBlock */
/** @typedef {{ type: "text", text: string } | { type: "image" | "audio" | "resource" | "resource_link" }} AcpMessageContent */
/** @typedef {{ path?: string }} AcpLocation */
/**
 * @typedef {object} AcpToolCall
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [title]
 * @property {string} [kind]
 * @property {AcpLocation[]} [locations]
 * @property {AcpContentBlock[]} [content]
 * @property {Record<string, unknown> | null} [rawInput]
 */
/**
 * @typedef {AcpToolCall & {
 *   sessionUpdate: "tool_call" | "tool_call_update",
 *   toolCallId: string,
 *   status?: string,
 *   rawOutput?: unknown
 * }} AcpToolCallUpdate
 */
/**
 * @typedef {AcpToolCallUpdate |
 *   { sessionUpdate: "available_commands_update", availableCommands?: { name?: string }[] } |
 *   { sessionUpdate: "config_option_update", configOptions?: unknown[] } |
 *   { sessionUpdate: "agent_message_chunk", content?: AcpMessageContent }
 * } AcpSessionUpdate
 */
/** @typedef {{ sessionId?: string, update?: AcpSessionUpdate }} AcpNotification */
/** @typedef {{ optionId: string, kind: string, name?: string }} AcpPermissionOption */
/** @typedef {{ sessionId?: string, options?: AcpPermissionOption[], toolCall?: AcpToolCall }} AcpPermissionRequest */
/**
 * @typedef {import("./controller-types.mjs").ProviderTurnState<AcpContext> & {
 *   generation: number,
 *   messageIndex: number,
 *   acceptingUpdates: boolean,
 *   toolCalls: Map<string, AcpToolCall>,
 *   rejectConnection?: (reason: Error) => void
 * }} AcpTurn
 */

/** @param {AcpToolCall} rec */
function extractAcpArtifactCandidates(rec) {
  if (!rec) return [];
  const kind = String(rec.kind || "").toLowerCase();
  if (kind === "read" || kind === "search" || kind === "think") return [];
  const label = String(rec.name || rec.title || "").toLowerCase();
  if (/^(read|view|list|search|find|grep|brain_read|brain_list)/.test(label)) {
    return [];
  }
  const candidates = [];
  if (Array.isArray(rec.locations)) {
    for (const loc of rec.locations) {
      if (typeof loc?.path === "string" && loc.path.trim()) {
        candidates.push(loc.path.trim());
      }
    }
  }
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (
        block?.type === "diff" &&
        typeof block?.path === "string" &&
        block.path.trim()
      ) {
        candidates.push(block.path.trim());
      }
    }
  }
  const rawInput = rec.rawInput;
  if (rawInput && typeof rawInput === "object") {
    for (const key of [
      "file_path",
      "TargetFile",
      "target_file",
      "path",
      "Path",
      "file",
    ]) {
      const value = rawInput[key];
      if (typeof value === "string" && value.trim()) {
        candidates.push(value.trim());
      }
    }
  }
  const looksLikeWrite =
    kind === "edit" ||
    /(write|edit|create|save|replace|artifact|patch|put)/.test(label) ||
    Boolean(
      rawInput &&
      typeof rawInput === "object" &&
      (rawInput.CodeContent !== undefined ||
        rawInput.content !== undefined ||
        rawInput.TargetContent !== undefined ||
        rawInput.ReplacementContent !== undefined ||
        rawInput.ReplacementChunks !== undefined ||
        rawInput.file_path !== undefined ||
        rawInput.TargetFile !== undefined),
    );
  return looksLikeWrite ? [...new Set(candidates)] : [];
}

export function createAcpController() {
  const connectionId = randomUUID();
  /** @type {ProviderChild | null} */
  let child = null;
  /** @type {ReturnType<typeof providerRpc> | null} */
  let rpc = null;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {string | null} */
  let observedModel = null;
  /** @type {AcpTurn | null} */
  let activeTurn = null;
  let closing = false;
  /** @type {Promise<void> | null} */
  let connectPromise = null;
  /** @type {string | null} */
  let autoCleanupGeminiDir = null;
  let promptGeneration = 0;
  /** @type {string[] | null} */
  let latestObservedCommands = null;
  /** @type {AcpContext | null} */
  let connectCtx = null;
  const createdAt = new Date().toISOString();
  let lastUsedAt = Date.now();

  const isAlive = () =>
    !closing &&
    Boolean(
      child &&
      !exitedChildren.has(child) &&
      rpc &&
      !rpc.isClosed() &&
      (child.exitCode === null || child.exitCode === undefined),
    );

  const requireRpc = () => {
    if (!rpc) throw new Error("Antigravity ACP desconectado");
    return rpc;
  };

  /**
   * @param {AcpContext} ctx
   * @param {unknown} [currentConfigOptions]
   */
  async function ensureModelPinned(ctx, currentConfigOptions = null) {
    if (!ctx.session.modelo) return;
    if (currentConfigOptions) {
      const current = verifyAcpConfigModel(
        currentConfigOptions,
        ctx.session.modelo,
        { throwOnMismatch: false },
      );
      if (current === ctx.session.modelo) {
        observedModel = current;
        return;
      }
    }
    if (observedModel === ctx.session.modelo) return;
    try {
      const configRes = /** @type {{ configOptions?: unknown }} */ (
        await requireRpc().call("session/set_config_option", {
          sessionId,
          configId: "model",
          value: ctx.session.modelo,
        })
      );
      if (Array.isArray(configRes?.configOptions)) {
        observedModel = verifyAcpConfigModel(
          configRes.configOptions,
          ctx.session.modelo,
        );
      } else {
        observedModel = ctx.session.modelo;
      }
    } catch (err) {
      if (
        (err?.message === "El proveedor rechazó la operación" &&
          err?.code === -32601) ||
        err?.code === -32602 ||
        err?.message === "Método no compatible"
      ) {
        await requireRpc().call("session/set_model", {
          sessionId,
          modelId: ctx.session.modelo,
        });
        observedModel = ctx.session.modelo;
      } else {
        throw err;
      }
    }
  }

  /** @param {AcpContext} ctx */
  async function ensureConnected(ctx) {
    connectCtx = ctx;
    if (isAlive() && sessionId) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const spec = await prepareAcpLaunchSpec(ctx);
      autoCleanupGeminiDir = spec.cleanupDir || null;
      child = trackChildExit(ctx.spawn(spec.bin, spec.args, spec.env));
      child.once("exit", () => {
        const turn = activeTurn;
        if (turn && !turn.settled) {
          turn.ctx?.invalidateConnection?.(
            connectionId,
            "Antigravity ACP cerró antes de finalizar el turno",
          );
          turn.rejectConnection?.(
            new Error("Antigravity ACP cerró antes de finalizar el turno"),
          );
        }
      });

      rpc = providerRpc(child, {
        onClose: (/** @type {string} */ reason) => {
          const turn = activeTurn;
          turn?.ctx?.invalidateConnection?.(connectionId, reason);
          turn?.rejectConnection?.(
            new Error(reason || "Antigravity ACP desconectado"),
          );
        },
        /**
         * @param {string} method
         * @param {AcpNotification} p
         */
        notify(method, p) {
          if (method === "session/update") {
            if (!p?.sessionId || !sessionId || p.sessionId === sessionId) {
              if (
                p.update?.sessionUpdate === "available_commands_update" &&
                Array.isArray(p.update.availableCommands)
              ) {
                const names = p.update.availableCommands
                  .map((c) => c?.name)
                  .filter(
                    /** @returns {name is string} */ (name) => Boolean(name),
                  );
                latestObservedCommands = names;
                const sink = activeTurn?.ctx || connectCtx;
                void sink?.onSkillsObserved?.({
                  source: "acp_available_commands",
                  names,
                });
              }
            }
          }
          const turn = activeTurn;
          if (
            !turn ||
            turn.settled ||
            turn !== activeTurn ||
            turn.connectionId !== connectionId ||
            method !== "session/update" ||
            !turn.acceptingUpdates
          ) {
            return;
          }
          if (p?.sessionId && sessionId && p.sessionId !== sessionId) {
            return;
          }
          const u = p.update;
          if (!u) return;
          if (
            u.sessionUpdate === "config_option_update" &&
            Array.isArray(u.configOptions) &&
            turn.ctx.session.modelo
          ) {
            observedModel = verifyAcpConfigModel(
              u.configOptions,
              turn.ctx.session.modelo,
            );
          }
          if (
            u.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text"
          ) {
            turn.ctx.delta(
              `acp:${turn.ctx.turnId}:${turn.messageIndex}`,
              u.content.text,
            );
          }
          if (u.sessionUpdate === "tool_call") {
            turn.messageIndex++;
            const record = {
              id: u.toolCallId,
              name: u.name || u.title || "",
              title: u.title || "",
              kind: u.kind || "",
              locations: Array.isArray(u.locations) ? u.locations : [],
              content: Array.isArray(u.content) ? u.content : [],
              rawInput: u.rawInput ?? null,
            };
            if (u.toolCallId) turn.toolCalls.set(u.toolCallId, record);
            turn.ctx.tool(u.toolCallId, {
              nombre: u.name || u.title,
              resumen: u.title,
              estado: u.status === "completed" ? "ok" : "pendiente",
            });
            if (u.status === "completed") {
              for (const cand of extractAcpArtifactCandidates(record)) {
                turn.pendingWork.push(
                  publishVerifiedWorkspaceArtifact({
                    ctx: turn.ctx,
                    cwd: turn.ctx.cwd,
                    rawPath: cand,
                    evidenceRefs: [
                      String(u.toolCallId || `acp:${turn.generation}`),
                    ],
                    comment: record.title || "Artefacto ACP",
                    publishedKeys: turn.publishedArtifactKeys,
                  }).catch(/** @returns {null} */ () => null),
                );
              }
            }
          }
          if (u.sessionUpdate === "tool_call_update") {
            const prev =
              (u.toolCallId && turn.toolCalls.get(u.toolCallId)) || {};
            const merged = {
              id: u.toolCallId || prev.id,
              name: u.name || u.title || prev.name || "",
              title: u.title || prev.title || "",
              kind: u.kind || prev.kind || "",
              locations: Array.isArray(u.locations)
                ? u.locations
                : prev.locations || [],
              content: Array.isArray(u.content)
                ? u.content
                : prev.content || [],
              rawInput: u.rawInput ?? prev.rawInput ?? null,
            };
            if (u.toolCallId) turn.toolCalls.set(u.toolCallId, merged);
            turn.ctx.tool(u.toolCallId, {
              resultado: text(u.content || u.rawOutput),
              estado:
                u.status === "failed"
                  ? "error"
                  : u.status === "completed"
                    ? "ok"
                    : "pendiente",
            });
            if (u.status === "completed") {
              for (const cand of extractAcpArtifactCandidates(merged)) {
                turn.pendingWork.push(
                  publishVerifiedWorkspaceArtifact({
                    ctx: turn.ctx,
                    cwd: turn.ctx.cwd,
                    rawPath: cand,
                    evidenceRefs: [
                      String(u.toolCallId || `acp:${turn.generation}`),
                    ],
                    comment: merged.title || "Artefacto ACP",
                    publishedKeys: turn.publishedArtifactKeys,
                  }).catch(/** @returns {null} */ () => null),
                );
              }
            }
          }
        },
        /**
         * @param {string} method
         * @param {AcpPermissionRequest} p
         * @param {RpcId} id
         * @param {RpcRequestMetadata} [rpcMeta]
         */
        async request(method, p, id, rpcMeta = {}) {
          const turn = activeTurn;
          if (
            !turn ||
            turn.settled ||
            !turn.acceptingUpdates ||
            turn.connectionId !== connectionId
          ) {
            throw Object.assign(new Error("Sin turno ACP activo"), {
              rpcCode: -32601,
            });
          }
          if (p?.sessionId && sessionId && p.sessionId !== sessionId) {
            throw Object.assign(new Error("Solicitud ACP de sesión ajena"), {
              rpcCode: -32601,
            });
          }
          if (method !== "session/request_permission") {
            throw new Error("Capacidad ACP no habilitada");
          }
          const reqGeneration = turn.generation;
          const rawOptions = Array.isArray(p.options) ? p.options : [];
          // Never auto-grant allow_always; prioritize allow_once and reject_once.
          const safeOptions = rawOptions.filter(
            (o) => o.kind !== "allow_always",
          );
          const sortedOptions = [...safeOptions].sort((a, b) => {
            /** @param {string} k */
            const rank = (k) =>
              k === "allow_once" ? 0 : k === "reject_once" ? 1 : 2;
            return rank(a.kind) - rank(b.kind);
          });
          if (sortedOptions.length === 0) {
            return { outcome: { outcome: "cancelled" } };
          }
          const tcKind = String(p.toolCall?.kind || "").toLowerCase();
          const tcName = String(p.toolCall?.name || "").toLowerCase();
          const tcTitle = String(p.toolCall?.title || "").toLowerCase();
          const isMcpTool = tcName.startsWith("mcp_");
          const denyWrite =
            profileDisallowsAction(turn.ctx, "write") &&
            (tcKind === "edit" ||
              tcKind === "delete" ||
              (isMcpTool
                ? /(write|put|upload|trash|finance_operation|delete|edit)/.test(
                    tcName,
                  )
                : /\b(write|edit|save|delete|replace|create|patch)\b/.test(
                    `${tcName} ${tcTitle}`,
                  )));
          const denyShell =
            profileDisallowsAction(turn.ctx, "shell") &&
            (tcKind === "execute" ||
              (!isMcpTool &&
                /\b(run_command|execute|bash|powershell|cmd|shell|command|terminal)\b/.test(
                  `${tcName} ${tcTitle}`,
                )));
          if (denyWrite || denyShell) {
            const rejectOpt = sortedOptions.find(
              (o) => o.kind === "reject_once",
            );
            return rejectOpt
              ? {
                  outcome: {
                    outcome: "selected",
                    optionId: rejectOpt.optionId,
                  },
                }
              : { outcome: { outcome: "cancelled" } };
          }
          const choices = sortedOptions.map((o) => o.optionId);
          const answer = await turn.ctx.ask(
            String(id),
            {
              kind: "approval",
              title: p.toolCall?.title || "Permiso de Antigravity",
              choices,
              labels: Object.fromEntries(
                sortedOptions.map((o) => [o.optionId, o.name || o.optionId]),
              ),
            },
            {
              connectionId,
              writeAck: rpcMeta.writeAck,
              isConnectionAlive: rpcMeta.isWritable,
            },
          );
          if (
            !activeTurn ||
            activeTurn !== turn ||
            turn.settled ||
            !turn.acceptingUpdates ||
            turn.generation !== reqGeneration ||
            turn.connectionId !== connectionId
          ) {
            return { outcome: { outcome: "cancelled" } };
          }
          if (!answer?.decision || answer.decision === "cancel") {
            return { outcome: { outcome: "cancelled" } };
          }
          return {
            outcome: { outcome: "selected", optionId: answer.decision },
          };
        },
      });

      const init = /** @type {{
        authMethods?: unknown[],
        agentCapabilities?: { sessionCapabilities?: { resume?: boolean }, loadSession?: boolean }
      }} */ (
        await rpc.call("initialize", {
          protocolVersion: 1,
          clientCapabilities: spec.isolatedDir
            ? {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              }
            : {},
          clientInfo: { name: "secondbrain", version: "1.0.0" },
        })
      );
      if (
        ctx.geminiDir ||
        (Array.isArray(init.authMethods) && init.authMethods.length > 0)
      ) {
        await rpc.call("authenticate", { methodId: "oauth-personal" });
      }
      const canResume = Boolean(
        init.agentCapabilities?.sessionCapabilities?.resume,
      );
      const canLoad = Boolean(init.agentCapabilities?.loadSession);
      if (ctx.session.conversacionId && !canResume && !canLoad) {
        throw new Error("Antigravity no permite reanudar esta sesión");
      }

      let result;
      if (ctx.session.conversacionId) {
        if (canResume) {
          try {
            result = await rpc.call("session/resume", {
              cwd: ctx.cwd,
              mcpServers: spec.servers,
              sessionId: ctx.session.conversacionId,
            });
          } catch (err) {
            if (err?.code === -32601 && canLoad) {
              result = await rpc.call("session/load", {
                cwd: ctx.cwd,
                mcpServers: spec.servers,
                sessionId: ctx.session.conversacionId,
              });
            } else {
              throw err;
            }
          }
        } else {
          result = await rpc.call("session/load", {
            cwd: ctx.cwd,
            mcpServers: spec.servers,
            sessionId: ctx.session.conversacionId,
          });
        }
      } else {
        result = await rpc.call("session/new", {
          cwd: ctx.cwd,
          mcpServers: spec.servers,
        });
      }
      const sessionResult =
        /** @type {{ sessionId: string, configOptions?: unknown }} */ (result);
      sessionId = ctx.session.conversacionId || sessionResult.sessionId;
      await ctx.nativeId(sessionId);
      await ensureModelPinned(ctx, sessionResult?.configOptions);
    })();
    try {
      await connectPromise;
    } catch (err) {
      await shutdown("Error inicializando ACP");
      throw err;
    } finally {
      connectPromise = null;
    }
  }

  /** @param {AcpContext} ctx */
  async function runTurn(ctx) {
    lastUsedAt = Date.now();
    const validatedAttachments = validarAdjuntosMotor(
      "agy",
      ctx.attachments || [],
      ctx.cwd,
    );
    await ensureConnected(ctx);
    if (
      Array.isArray(latestObservedCommands) &&
      typeof ctx.onSkillsObserved === "function"
    ) {
      void ctx.onSkillsObserved({
        source: "acp_available_commands",
        names: latestObservedCommands,
      });
    }
    await ensureModelPinned(ctx);

    let aborted = false;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;
    /** @type {PromiseWithResolvers<never>} */
    const { promise: disconnectPromise, reject: rejectDisconnect } =
      Promise.withResolvers();
    disconnectPromise.catch(() => {});

    const generation = ++promptGeneration;
    /** @type {AcpTurn} */
    const turn = {
      ctx,
      connectionId,
      generation,
      messageIndex: 0,
      acceptingUpdates: true,
      settled: false,
      toolCalls: new Map(),
      pendingWork: [],
      publishedArtifactKeys: new Set(),
      rejectConnection: rejectDisconnect,
    };
    activeTurn = turn;

    ctx.onAbort(() => {
      if (activeTurn !== turn || turn.settled) return;
      aborted = true;
      if (sessionId && rpc?.isWritable()) {
        try {
          rpc.notify("session/cancel", { sessionId });
        } catch {}
      }
      killTimer = setTimeout(() => {
        if (activeTurn === turn && !turn.settled) {
          void shutdown("Timeout interrumpiendo turno ACP");
        }
      }, ctx.interruptKillGraceMs ?? 3000);
      killTimer.unref?.();
    });

    ctx.onControl?.({
      supportsSteer: true,
      connectionId,
      pid: child?.pid ?? null,
      steer: async (steerText, steerAttachments = []) => {
        if (
          activeTurn !== turn ||
          turn.settled ||
          !sessionId ||
          !rpc?.isWritable()
        ) {
          throw new Error("No hay sesión ACP activa para redirigir.");
        }
        const promptBlocks = formatAcpInput(
          steerText,
          validarAdjuntosMotor("agy", steerAttachments, ctx.cwd),
        );
        return rpc.call(
          "session/prompt",
          { sessionId, prompt: promptBlocks },
          0,
        );
      },
    });

    try {
      const completion = /** @type {{ stopReason?: string }} */ (
        await Promise.race([
          requireRpc().call(
            "session/prompt",
            {
              sessionId,
              prompt: formatAcpInput(ctx.prompt, validatedAttachments),
            },
            0,
          ),
          disconnectPromise,
        ])
      );
      clearTimeout(killTimer);
      turn.acceptingUpdates = false;
      await Promise.allSettled(turn.pendingWork);
      turn.settled = true;
      if (activeTurn === turn) activeTurn = null;
      lastUsedAt = Date.now();
      if (completion.stopReason === "cancelled") {
        return {
          status: "interrupted",
          pid: child?.pid ?? null,
          persistent: isAlive(),
          modelVerified: observedModel,
        };
      }
      if (completion.stopReason !== "end_turn") {
        throw new Error("Antigravity no confirmó un turno completo");
      }
      return {
        status: "completed",
        ...(aborted ? { aborted: true } : {}),
        pid: child?.pid ?? null,
        persistent: isAlive(),
        modelVerified: observedModel,
      };
    } catch (err) {
      clearTimeout(killTimer);
      turn.acceptingUpdates = false;
      await Promise.allSettled(turn.pendingWork);
      turn.settled = true;
      if (activeTurn === turn) activeTurn = null;
      if (aborted) {
        return {
          status: "interrupted",
          pid: child?.pid ?? null,
          persistent: isAlive(),
        };
      }
      throw err;
    }
  }

  async function shutdown(reason = "Cierre explícito") {
    closing = true;
    const currentChild = child;
    const currentRpc = rpc;
    if (activeTurn) {
      activeTurn.acceptingUpdates = false;
      activeTurn.settled = true;
      activeTurn.rejectConnection?.(new Error(reason));
      activeTurn = null;
    }
    sessionId = null;
    observedModel = null;
    child = null;
    rpc = null;
    currentRpc?.close(reason);
    if (currentChild) {
      try {
        currentChild.kill("SIGTERM");
      } catch {}
      await waitChildExit(currentChild, 1200);
    }
    if (autoCleanupGeminiDir) {
      const cleanup = autoCleanupGeminiDir;
      autoCleanupGeminiDir = null;
      await rm(cleanup, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    motor: "agy",
    connectionId,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    pid: () => (isAlive() ? (child?.pid ?? null) : null),
    isAlive,
    capabilities: () => ({
      persistentProcess: true,
      supportsSteer: true,
      supportsInterrupt: true,
      supportsResume: true,
      supportsElicitationForm: false,
      supportsUserInput: false,
    }),
    runTurn,
    interrupt: () => {
      if (sessionId && rpc?.isWritable()) {
        try {
          rpc.notify("session/cancel", { sessionId });
        } catch {}
      }
    },
    shutdown,
  };
}
