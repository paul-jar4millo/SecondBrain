// Controller for the Codex app-server protocol.
import { randomUUID } from "node:crypto";
import { ErrorLanzador } from "../../errors.mjs";
import { validarAdjuntosMotor } from "../../engines.mjs";
import { providerRpc } from "../../provider-rpc.mjs";
import {
  buildCodexArgs,
  buildCodexThreadMcpConfig,
  inspectCodexConfiguredMcps,
} from "./codex-config.mjs";
import {
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "./elicitation.mjs";
import {
  exitedChildren,
  formatCodexInput,
  profileDisallowsAction,
  publishVerifiedWorkspaceArtifact,
  resolveMcpServers,
  text,
  trackChildExit,
  waitChildExit,
} from "./shared.mjs";

/**
 * @typedef {import("./controller-types.mjs").ProviderTurnContext &
 *   import("./codex-config.mjs").CodexConfigContext &
 *   import("./codex-config.mjs").CodexArgsContext & {
 *     verifyMcpRuntime?: boolean,
 *     requireConfigRead?: boolean,
 *     observeSkills?: boolean,
 *     expectedSkills?: string[],
 *     expire(id: string): void
 *   }} CodexContext
 */
/** @typedef {Partial<import("../../provider-rpc.mjs").RpcRequestMetadata>} RpcRequestMetadata */
/** @typedef {import("../../provider-rpc.mjs").RpcId} RpcId */
/** @typedef {import("../../provider-rpc.mjs").ProviderChild} ProviderChild */
/** @typedef {{ id?: string, status?: string }} CodexTurnPayload */
/** @typedef {{ threadId?: string, thread?: { id?: string }, turnId?: string, turn?: CodexTurnPayload }} CodexTurnEvent */
/**
 * @typedef {object} CodexItem
 * @property {string} id
 * @property {string} type
 * @property {string} [text]
 * @property {unknown} [command]
 * @property {unknown} [query]
 * @property {string} [tool]
 * @property {string} [name]
 * @property {{ path?: string, kind?: string }[]} [changes]
 * @property {string} [aggregatedOutput]
 * @property {{ isError?: boolean }} [result]
 * @property {string} [status]
 * @property {Record<string, unknown>} [arguments]
 */
/**
 * @typedef {CodexTurnEvent & {
 *   toModel?: string, model?: string, actualModel?: string,
 *   itemId?: string, delta?: string, item?: CodexItem, requestId?: string | number
 * }} CodexNotification
 */
/**
 * @typedef {CodexTurnEvent & {
 *   questions?: unknown[], mode?: string, requestedSchema?: unknown,
 *   message?: string, serverName?: string, url?: string,
 *   reason?: string, command?: unknown, changes?: unknown,
 *   permissions?: unknown, availableDecisions?: string[]
 * }} CodexRequest
 */
/**
 * @typedef {{ answers: Record<string, { answers: unknown[] }> } |
 *   { action: "accept" | "decline" | "cancel", content: object | null, _meta: null } |
 *   { permissions: unknown, scope: "turn" } |
 *   { decision: string | undefined }
 * } CodexResponse
 */
/** @typedef {{ status: "completed" | "interrupted", turnId: string | null, pid: number | null, persistent: boolean }} CodexTurnResult */
/**
 * @typedef {import("./controller-types.mjs").ProviderTurnState<CodexContext> & {
 *   expectedThreadId: string | null,
 *   activeTurnId: string | null,
 *   startResponded: boolean,
 *   earlyCompletion: { turnId: string, turn: CodexTurnPayload } | null,
 *   aborted: boolean,
 *   killTimer: NodeJS.Timeout | null,
 *   resolve: (result: CodexTurnResult) => void,
 *   reject: (reason: unknown) => void
 * }} CodexTurn
 */
/** @typedef {{ name?: string, tools?: object, runtimeStatus?: unknown, serverInfo?: unknown }} CodexMcpStatus */

export function createCodexController() {
  const connectionId = randomUUID();
  /** @type {Set<string>} */
  const retiredTurnIds = new Set();
  /** @type {ProviderChild | null} */
  let child = null;
  /** @type {ReturnType<typeof providerRpc> | null} */
  let rpc = null;
  /** @type {string | null} */
  let threadId = null;
  /** @type {CodexTurn | null} */
  let activeTurn = null;
  let closing = false;
  /** @type {Promise<void> | null} */
  let connectPromise = null;
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

  /**
   * @param {CodexTurn | null} turn
   * @param {CodexTurnEvent} [p]
   * @returns {turn is CodexTurn}
   */
  const acceptTurnEvent = (turn, p = {}) => {
    if (
      !turn ||
      turn.settled ||
      activeTurn !== turn ||
      turn.connectionId !== connectionId
    ) {
      return false;
    }
    const msgThreadId = p?.threadId ?? p?.thread?.id ?? null;
    if (msgThreadId && threadId && msgThreadId !== threadId) {
      return false;
    }
    const msgTurnId = p?.turnId ?? p?.turn?.id ?? null;
    if (msgTurnId && retiredTurnIds.has(msgTurnId)) {
      return false;
    }
    if (turn.activeTurnId && msgTurnId && msgTurnId !== turn.activeTurnId) {
      return false;
    }
    return true;
  };

  /**
   * @template {"resolve" | "reject"} Method
   * @param {CodexTurn} turn
   * @param {Method} method
   * @param {Parameters<CodexTurn[Method]>[0]} payload
   */
  const settleActiveTurn = (turn, method, payload) => {
    if (!turn || activeTurn !== turn || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.killTimer ?? undefined);
    if (turn.activeTurnId) {
      retiredTurnIds.add(turn.activeTurnId);
    }
    activeTurn = null;
    turn[method](/** @type {CodexTurnResult} */ (payload));
  };

  /**
   * @param {CodexTurn} turn
   * @param {CodexTurnPayload | undefined} turnPayload
   */
  const finalizeCompletedTurn = (turn, turnPayload) => {
    const status = turnPayload?.status;
    Promise.allSettled(turn.pendingWork)
      .then(() => {
        if (activeTurn !== turn || turn.settled) return;
        if (status === "completed") {
          settleActiveTurn(turn, "resolve", {
            status: "completed",
            turnId: turnPayload?.id ?? turn.activeTurnId,
            pid: child?.pid ?? null,
            persistent: isAlive(),
          });
        } else if (status === "interrupted") {
          settleActiveTurn(turn, "resolve", {
            status: "interrupted",
            turnId: turnPayload?.id ?? turn.activeTurnId,
            pid: child?.pid ?? null,
            persistent: isAlive(),
          });
        } else {
          settleActiveTurn(
            turn,
            "reject",
            new Error("Turno de Codex interrumpido o fallido"),
          );
        }
      })
      .catch((err) => settleActiveTurn(turn, "reject", err));
  };

  /** @param {CodexContext} ctx */
  async function ensureConnected(ctx) {
    if (isAlive() && threadId) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const mcpServers = resolveMcpServers(ctx);
      const disableInherited = ctx.disableInheritedMcp !== false;
      const bin = ctx.operatorEnv?.SB_CODEX_BIN || "codex";
      const discoveredKeys = disableInherited
        ? await inspectCodexConfiguredMcps(ctx, bin)
        : new Map();
      const args = buildCodexArgs(ctx, mcpServers, discoveredKeys);
      child = trackChildExit(ctx.spawn(bin, args, ctx.env));
      child.once("exit", () => {
        const turn = activeTurn;
        if (turn && !turn.settled) {
          if (turn.aborted) {
            settleActiveTurn(turn, "resolve", {
              status: "interrupted",
              turnId: turn.activeTurnId,
              pid: child?.pid ?? null,
              persistent: false,
            });
          } else {
            turn.ctx.invalidateConnection?.(
              connectionId,
              "Codex cerró antes de finalizar el turno",
            );
            settleActiveTurn(
              turn,
              "reject",
              new Error("Codex cerró antes de finalizar el turno"),
            );
          }
        }
      });

      rpc = providerRpc(child, {
        onClose: (/** @type {string} */ reason) => {
          const turn = activeTurn;
          turn?.ctx?.invalidateConnection?.(connectionId, reason);
          if (turn && !turn.settled) {
            settleActiveTurn(
              turn,
              turn.aborted ? "resolve" : "reject",
              turn.aborted
                ? {
                    status: "interrupted",
                    turnId: turn.activeTurnId,
                    pid: child?.pid ?? null,
                    persistent: false,
                  }
                : new Error(reason || "Codex se desconectó"),
            );
          }
        },
        /**
         * @param {string} method
         * @param {unknown} params
         */
        notify(method, params) {
          // The RPC layer passes untyped params; this is the shape the provider sends.
          const p = /** @type {CodexNotification} */ (params);
          const turn = activeTurn;
          if (!acceptTurnEvent(turn, p)) return;
          if (method === "thread/started" && p.thread?.id) {
            if (!threadId || p.thread.id === threadId) {
              void turn.ctx.nativeId(p.thread.id);
            }
            return;
          }
          if (method === "turn/started" && p.turn?.id) {
            if (!turn.activeTurnId) {
              turn.activeTurnId = p.turn.id;
            }
            return;
          }
          if (method === "model/rerouted") {
            if (
              p?.turnId &&
              !turn.activeTurnId &&
              !retiredTurnIds.has(p.turnId)
            ) {
              turn.activeTurnId = p.turnId;
            }
            const actualModel = p?.toModel || p?.model || p?.actualModel || "";
            if (
              turn.ctx.session.modelo &&
              actualModel !== turn.ctx.session.modelo
            ) {
              settleActiveTurn(
                turn,
                "reject",
                new Error(
                  `Codex redirigió el modelo a "${actualModel || "desconocido"}" sin autorización`,
                ),
              );
              return;
            }
          }
          if (method === "item/agentMessage/delta") {
            // Codex always sends itemId and delta with this notification.
            turn.ctx.delta(
              /** @type {string} */ (p.itemId),
              /** @type {string} */ (p.delta),
            );
          }
          if (method === "item/started" || method === "item/completed") {
            const item = p.item;
            // Item notifications always carry the item; nothing to do without it.
            if (!item) return;
            if (item.type === "agentMessage") {
              turn.ctx.message(item.id, item.text || "");
            } else if (
              [
                "commandExecution",
                "fileChange",
                "mcpToolCall",
                "webSearch",
              ].includes(item.type)
            ) {
              turn.ctx.tool(item.id, {
                nombre: item.type,
                resumen: text(
                  item.command || item.query || item.tool || item.changes,
                ),
                resultado: item.aggregatedOutput || text(item.result),
                estado:
                  method === "item/started"
                    ? "pendiente"
                    : item.status === "failed"
                      ? "error"
                      : "ok",
              });
              if (method === "item/completed" && item.status !== "failed") {
                if (item.type === "fileChange" && Array.isArray(item.changes)) {
                  for (const ch of item.changes) {
                    if (ch?.kind === "delete" || typeof ch?.path !== "string") {
                      continue;
                    }
                    const work = publishVerifiedWorkspaceArtifact({
                      ctx: turn.ctx,
                      cwd: turn.ctx.cwd,
                      rawPath: ch.path,
                      evidenceRefs: [
                        String(item.id || turn.activeTurnId || turn.ctx.turnId),
                      ],
                      comment: `Cambio Codex (${ch.kind || "update"})`,
                      publishedKeys: turn.publishedArtifactKeys,
                    }).catch(/** @returns {null} */ () => null);
                    turn.pendingWork.push(work);
                  }
                } else if (
                  item.type === "mcpToolCall" &&
                  !item.result?.isError
                ) {
                  const candidatePath =
                    item.arguments?.path ||
                    item.arguments?.file_path ||
                    item.arguments?.target_file ||
                    null;
                  const toolName = String(
                    item.tool || item.name || "",
                  ).toLowerCase();
                  if (
                    candidatePath &&
                    /(write|create|edit|artifact|put)/.test(toolName)
                  ) {
                    const work = publishVerifiedWorkspaceArtifact({
                      ctx: turn.ctx,
                      cwd: turn.ctx.cwd,
                      rawPath: candidatePath,
                      evidenceRefs: [
                        String(item.id || turn.activeTurnId || turn.ctx.turnId),
                      ],
                      comment: `Herramienta MCP ${item.tool || item.name}`,
                      publishedKeys: turn.publishedArtifactKeys,
                    }).catch(/** @returns {null} */ () => null);
                    turn.pendingWork.push(work);
                  }
                }
              }
            }
          }
          if (method === "serverRequest/resolved") {
            turn.ctx.expire(String(p.requestId));
          }
          if (method === "turn/completed") {
            const completedTurn = p.turn;
            const completedTurnId = completedTurn?.id ?? null;
            if (completedTurnId && retiredTurnIds.has(completedTurnId)) {
              return;
            }
            if (!turn.activeTurnId) {
              if (!turn.startResponded) {
                if (completedTurn?.id) {
                  turn.earlyCompletion = {
                    turnId: completedTurn.id,
                    turn: completedTurn,
                  };
                }
                return;
              }
            }
            if (
              turn.activeTurnId &&
              completedTurnId &&
              completedTurnId !== turn.activeTurnId
            ) {
              return;
            }
            if (!completedTurnId && !turn.startResponded) {
              return;
            }
            finalizeCompletedTurn(turn, p.turn);
          }
        },
        /**
         * @param {string} method
         * @param {unknown} params
         * @param {RpcId} id
         * @param {RpcRequestMetadata} [rpcMeta]
         * @returns {Promise<CodexResponse>}
         */
        async request(method, params, id, rpcMeta = {}) {
          // The RPC layer passes untyped params; this is the shape the provider sends.
          const p = /** @type {CodexRequest} */ (params);
          const turn = activeTurn;
          if (!acceptTurnEvent(turn, p)) {
            throw Object.assign(
              new Error("Solicitud obsoleta de turno o hilo inactivo en Codex"),
              { rpcCode: -32601 },
            );
          }
          const requestTurnToken = turn;
          const askMeta = {
            connectionId,
            writeAck: rpcMeta.writeAck,
            isConnectionAlive: rpcMeta.isWritable,
          };
          if (
            method === "item/tool/requestUserInput" ||
            method === "tool/requestUserInput"
          ) {
            const answers = await turn.ctx.ask(
              String(id),
              {
                kind: "question",
                title: "Codex necesita tu respuesta",
                questions: p.questions,
              },
              askMeta,
            );
            if (activeTurn !== requestTurnToken || requestTurnToken.settled) {
              throw new Error("Turno expirado al responder pregunta");
            }
            return {
              answers: Object.fromEntries(
                Object.entries(answers).map(([key, value]) => [
                  key,
                  { answers: Array.isArray(value) ? value : [value] },
                ]),
              ),
            };
          }
          if (method === "mcpServer/elicitation/request") {
            const mode = p?.mode || "form";
            if (mode !== "form") {
              throw new ErrorLanzador(
                `Modo de elicitación no soportado: "${mode}".`,
                400,
              );
            }
            if (p?.requestedSchema) {
              validateRequestedSchema(p.requestedSchema);
            }
            const answer = await turn.ctx.ask(
              String(id),
              {
                kind: "approval",
                title:
                  p?.message ||
                  `Solicitud MCP de ${p?.serverName || "servidor externo"}`,
                detail: text(p?.requestedSchema || p?.url || p),
                serverName: p?.serverName || null,
                mode,
                requestedSchema: p?.requestedSchema || null,
                choices: ["accept", "decline", "cancel"],
              },
              askMeta,
            );
            if (activeTurn !== requestTurnToken || requestTurnToken.settled) {
              return { action: "cancel", content: null, _meta: null };
            }
            if (answer.decision !== "accept") {
              return {
                action: answer.decision === "decline" ? "decline" : "cancel",
                content: null,
                _meta: null,
              };
            }
            const validatedContent = validateAndExtractElicitationContent(
              p?.requestedSchema,
              answer.content,
              mode,
            );
            return {
              action: "accept",
              content: validatedContent,
              _meta: null,
            };
          }
          if (method.endsWith("/requestApproval")) {
            const writeBlocked =
              profileDisallowsAction(turn.ctx, "write") &&
              (method.includes("file") ||
                Boolean(p.changes) ||
                /write|edit|patch|delete|rm/i.test(
                  `${p.reason || ""} ${text(p.permissions)}`,
                ));
            const shellBlocked =
              profileDisallowsAction(turn.ctx, "shell") &&
              (Boolean(p.command) ||
                method.includes("command") ||
                /exec|shell|command/i.test(p.reason || ""));
            if (writeBlocked || shellBlocked) {
              if (method === "item/permissions/requestApproval") {
                return { permissions: {}, scope: "turn" };
              }
              return { decision: "decline" };
            }
            const offered = p.availableDecisions?.filter((d) =>
              ["accept", "decline", "cancel"].includes(d),
            );
            const choices = offered?.length
              ? offered
              : ["accept", "decline", "cancel"];
            const answer = await turn.ctx.ask(
              String(id),
              {
                kind: "approval",
                title: p.reason || "Permiso solicitado por Codex",
                detail: text(p.command || p.changes || p.permissions),
                choices,
              },
              askMeta,
            );
            if (activeTurn !== requestTurnToken || requestTurnToken.settled) {
              return { decision: "cancel" };
            }
            if (method === "item/permissions/requestApproval") {
              return {
                permissions: answer.decision === "accept" ? p.permissions : {},
                scope: "turn",
              };
            }
            return { decision: answer.decision };
          }
          throw new Error("Solicitud de Codex no compatible");
        },
      });

      const initResult = /** @type {{ codexHome?: string }} */ (
        await rpc.call("initialize", {
          clientInfo: { name: "secondbrain", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        })
      );
      rpc.notify("initialized", {});

      if (disableInherited && (initResult?.codexHome || ctx.verifyMcpRuntime)) {
        try {
          const mcpStatus = /** @type {{ data?: CodexMcpStatus[] }} */ (
            await rpc.call("mcpServerStatus/list", {})
          );
          const activeUnexpected = (mcpStatus?.data || []).filter((entry) => {
            if (!entry?.name || Object.hasOwn(mcpServers, entry.name)) {
              return false;
            }
            const hasTools = entry.tools && Object.keys(entry.tools).length > 0;
            const activeStatus =
              Boolean(entry.runtimeStatus) &&
              String(entry.runtimeStatus).toLowerCase() !== "disabled";
            return Boolean(entry.serverInfo) || hasTools || activeStatus;
          });
          if (activeUnexpected.length > 0) {
            throw new Error(
              `Aislamiento MCP de Codex violado (conectores no autorizados activos: ${activeUnexpected.map((e) => e.name).join(", ")})`,
            );
          }
        } catch (err) {
          if (
            err?.message?.includes("Aislamiento MCP de Codex violado") ||
            ctx.verifyMcpRuntime
          ) {
            throw err;
          }
        }
        try {
          let cfgRead;
          if (ctx.requireConfigRead) {
            cfgRead = await rpc.call("config/read", { includeLayers: true });
          } else {
            /** @type {NodeJS.Timeout} */
            let timer;
            cfgRead = await Promise.race([
              rpc.call("config/read", { includeLayers: true }),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), 150);
                timer.unref?.();
              }),
            ]).finally(() => clearTimeout(timer));
          }
          const result =
            /** @type {{ config?: { mcp_servers?: Record<string, { enabled?: boolean }> } }} */ (
              cfgRead
            );
          const effectiveMcp = result?.config?.mcp_servers;
          if (effectiveMcp && typeof effectiveMcp === "object") {
            const enabledUnexpected = Object.entries(effectiveMcp)
              .filter(
                ([name, srv]) =>
                  !Object.hasOwn(mcpServers, name) && srv?.enabled !== false,
              )
              .map(([name]) => name);
            if (enabledUnexpected.length > 0) {
              throw new Error(
                `Aislamiento MCP de Codex violado en configuración efectiva (${enabledUnexpected.join(", ")})`,
              );
            }
          }
        } catch (err) {
          if (
            err?.message?.includes("Aislamiento MCP de Codex violado") ||
            ctx.requireConfigRead
          ) {
            throw err;
          }
          if (err?.code !== -32601 && err?.rpcCode !== -32601) {
            /* ignore only when mock server does not implement config/read */
          }
        }
      }

      const config = {
        cwd: ctx.cwd,
        approvalPolicy: "on-request",
        sandbox: profileDisallowsAction(ctx, "write")
          ? "read-only"
          : "workspace-write",
        ...(ctx.session.modelo ? { model: ctx.session.modelo } : {}),
        ...(ctx.session.esfuerzo ? { effort: ctx.session.esfuerzo } : {}),
        config: buildCodexThreadMcpConfig(
          mcpServers,
          disableInherited,
          discoveredKeys,
        ),
      };
      const result = /** @type {{ thread: { id: string } }} */ (
        await rpc.call(
          ctx.session.conversacionId ? "thread/resume" : "thread/start",
          {
            ...config,
            ...(ctx.session.conversacionId
              ? { threadId: ctx.session.conversacionId }
              : {}),
          },
        )
      );
      threadId = result.thread.id;
      await ctx.nativeId(threadId);
      if (
        ctx.onSkillsObserved &&
        (ctx.observeSkills || ctx.expectedSkills?.length)
      ) {
        try {
          /** @typedef {{ name?: string, id?: string }} CodexSkill */
          const skillsRes =
            /** @type {{ skills?: CodexSkill[], data?: CodexSkill[] }} */ (
              await rpc.call("skills/list", {
                cwds: ctx.cwd ? [ctx.cwd] : [],
              })
            );
          const names = (skillsRes?.skills || skillsRes?.data || [])
            .map((s) => s?.name || s?.id)
            .filter(/** @returns {name is string} */ (name) => Boolean(name));
          await ctx.onSkillsObserved({
            source: "codex_skills_list",
            names,
          });
        } catch {
          /* mock or older server may not expose skills/list */
        }
      }
    })();
    try {
      await connectPromise;
    } catch (err) {
      await shutdown("Error inicializando Codex");
      throw err;
    } finally {
      connectPromise = null;
    }
  }

  /** @param {CodexContext} ctx */
  async function runTurn(ctx) {
    lastUsedAt = Date.now();
    const validatedAttachments = validarAdjuntosMotor(
      "codex",
      ctx.attachments || [],
      ctx.cwd,
    );
    await ensureConnected(ctx);

    /** @type {PromiseWithResolvers<CodexTurnResult>} */
    const {
      promise: completed,
      resolve: resolveTurn,
      reject: rejectTurn,
    } = Promise.withResolvers();
    completed.catch(() => {});

    /** @type {CodexTurn} */
    const turn = {
      ctx,
      connectionId,
      expectedThreadId: threadId,
      activeTurnId: null,
      startResponded: false,
      earlyCompletion: null,
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
      if (threadId && turn.activeTurnId && rpc?.isWritable()) {
        rpc
          .call("turn/interrupt", { threadId, turnId: turn.activeTurnId }, 2000)
          .catch(() => {});
      }
      turn.killTimer = setTimeout(() => {
        if (activeTurn === turn && !turn.settled) {
          void shutdown("Timeout interrumpiendo turno Codex");
        }
      }, ctx.interruptKillGraceMs ?? 2500);
      turn.killTimer.unref?.();
    });

    ctx.onControl?.({
      supportsSteer: true,
      connectionId,
      pid: child?.pid ?? null,
      steer: async (steerText, steerAttachments = []) => {
        if (
          activeTurn !== turn ||
          turn.settled ||
          !threadId ||
          !turn.activeTurnId ||
          !rpc?.isWritable()
        ) {
          throw new Error("No hay turno activo de Codex para redirigir.");
        }
        const steerInput = formatCodexInput(
          steerText,
          validarAdjuntosMotor("codex", steerAttachments, ctx.cwd),
        );
        return rpc.call("turn/steer", {
          threadId,
          expectedTurnId: turn.activeTurnId,
          input: steerInput,
        });
      },
    });

    if (!rpc) throw new Error("Proveedor desconectado");
    const turnStarted = /** @type {{ turn?: CodexTurnPayload }} */ (
      await rpc.call("turn/start", {
        threadId,
        input: formatCodexInput(ctx.prompt, validatedAttachments),
        ...(ctx.session.modelo ? { model: ctx.session.modelo } : {}),
        ...(ctx.session.esfuerzo ? { effort: ctx.session.esfuerzo } : {}),
      })
    );
    if (activeTurn === turn && !turn.settled) {
      turn.startResponded = true;
      const authoritativeTurnId = turnStarted?.turn?.id || null;
      if (authoritativeTurnId) {
        if (retiredTurnIds.has(authoritativeTurnId)) {
          settleActiveTurn(
            turn,
            "reject",
            new Error("El proveedor reutilizó un turnId retirado en Codex"),
          );
        } else {
          turn.activeTurnId = authoritativeTurnId;
        }
      }
      if (
        !turn.settled &&
        turn.earlyCompletion &&
        (!turn.earlyCompletion.turnId ||
          !turn.activeTurnId ||
          turn.earlyCompletion.turnId === turn.activeTurnId)
      ) {
        const early = turn.earlyCompletion.turn;
        turn.earlyCompletion = null;
        finalizeCompletedTurn(turn, early);
      } else {
        turn.earlyCompletion = null;
      }
    }
    const outcome = await completed;
    lastUsedAt = Date.now();
    return outcome;
  }

  async function shutdown(reason = "Cierre explícito") {
    closing = true;
    const currentChild = child;
    const currentRpc = rpc;
    if (activeTurn && !activeTurn.settled) {
      settleActiveTurn(activeTurn, "reject", new Error(reason));
    }
    threadId = null;
    child = null;
    rpc = null;
    currentRpc?.close(reason);
    if (currentChild) {
      try {
        currentChild.kill("SIGTERM");
      } catch {}
      await waitChildExit(currentChild, 1200);
    }
  }

  return {
    motor: "codex",
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
      supportsElicitationForm: true,
      supportsUserInput: true,
    }),
    runTurn,
    interrupt: () => {
      const turn = activeTurn;
      if (!turn || turn.settled) return;
      turn.aborted = true;
      if (threadId && turn.activeTurnId && rpc?.isWritable()) {
        rpc
          .call("turn/interrupt", { threadId, turnId: turn.activeTurnId }, 2000)
          .catch(() => {});
      }
    },
    shutdown,
  };
}
