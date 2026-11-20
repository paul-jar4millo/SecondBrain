import { randomUUID } from "node:crypto";
import { artifactEntry, storeArtifactBlob } from "./artifacts.mjs";
import { canonicalStringify, expireRequest } from "./persistence.mjs";
import {
  promoteDeliveredReceipts,
  reconcileUnconfirmedCallbacks,
} from "./receipts.mjs";

/** @import {ConversationContext, ConversationController, ConversationItem, ConversationRequest, ConversationState, NativeCallbackStatus, PendingConversationCallback, RunConversationOptions} from "../provider-conversation-types.mjs" */
/** @import {ProviderControl} from "../lib/providers/controller-types.mjs" */
/** @import {ConversationRuntime} from "./controllers.mjs" */

/**
 * Runs one provider turn: reuses or starts the session's controller, streams
 * its items, events, artifacts and requests into the persisted state, and
 * closes every callback the turn left open.
 * @param {ConversationRuntime & {
 *   shutdownController: (id: string, options?: { reason?: string }) => Promise<unknown>
 * }} runtime
 */
export function createTurnRunner({
  persistence,
  adapters,
  running,
  controllers,
  shutdownController,
}) {
  const { change, pushEvent, snapshot } = persistence;

  /** @param {RunConversationOptions} options */
  return async function run({
    session,
    prompt,
    attachments = [],
    mcpServers = undefined,
    cwd,
    env,
    operatorEnv,
    spawn,
    onNativeId,
    disableInheritedMcp = true,
    geminiDir = null,
    acpLogFile = null,
    settingSources = undefined,
    interruptKillGraceMs = undefined,
    toolProfile = null,
    verifiedBillingGrant = false,
    onSkillsObserved = null,
    observeSkills = false,
  }) {
    const adapter = adapters[session.motor];
    if (!adapter) throw new Error("Proveedor no compatible");
    const store = await persistence.load(session.id);
    const turnId = randomUUID();
    /** @type {Map<string, PendingConversationCallback>} */
    const callbacks = new Map();
    /** @type {(() => void)[]} */
    const aborters = [];
    /** @type {Partial<ProviderControl>} */
    let control = { supportsSteer: false };
    let nativeId = session.conversacionId;
    let sequence = 0;
    let aborted = false;
    let connectionDropped = false;
    let pendingWrite = Promise.resolve();
    let persistenceError;
    /** @type {ConversationController | null} */
    let activeController = null;
    let unconfirmedDelivered = false;

    // Stringifying an object literal always yields a string.
    const configSignature = /** @type {string} */ (
      canonicalStringify({
        motor: session.motor,
        modelo: session.modelo ?? null,
        esfuerzo: session.esfuerzo ?? null,
        cwd,
        mcpServers: mcpServers === undefined ? "undefined" : mcpServers,
        geminiDir,
        disableInheritedMcp,
        toolProfileId: toolProfile?.id ?? null,
      })
    );

    if (typeof adapter.createController === "function") {
      const existing = controllers.get(session.id);
      if (
        existing &&
        existing.controller.isAlive() &&
        existing.configSignature === configSignature
      ) {
        activeController = existing.controller;
      } else {
        if (existing) {
          await shutdownController(session.id, {
            reason: "Reinicio por cambio de configuración o desconexión previa",
          });
        }
        activeController = adapter.createController();
        controllers.set(session.id, {
          controller: activeController,
          configSignature,
        });
      }
    }
    const connectionId = activeController?.connectionId || randomUUID();
    const receiptTurn = {
      sessionId: session.id,
      turnId,
      connectionId,
      pushEvent,
    };
    const sourceId = session.memberId || session.motor;

    /** @param {(state: ConversationState) => void} fn */
    const write = (fn) => {
      const next = pendingWrite.then(() => change(store, fn));
      pendingWrite = next.catch((error) => {
        persistenceError = error;
      });
      return next;
    };

    /** @param {ConversationState} state */
    const promoteDelivered = (state) => {
      if (!unconfirmedDelivered) return;
      unconfirmedDelivered = promoteDeliveredReceipts(state, receiptTurn);
    };

    /**
     * @param {string} id
     * @param {Partial<ConversationItem>} patch
     */
    const upsert = (id, patch) =>
      write((state) => {
        let item = state.items.find((i) => i.id === id);
        if (!item) {
          item = { id, ts: new Date().toISOString() };
          state.items.push(item);
        }
        if (patch.herramienta)
          patch = {
            ...patch,
            herramienta: { ...item.herramienta, ...patch.herramienta },
          };
        Object.assign(item, patch);
      });

    /** @type {Map<string, { value: string, ephemeral: boolean }>} */
    const deltas = new Map();
    /** @type {NodeJS.Timeout | undefined} */
    let deltaTimer;
    const flushDeltas = () => {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
      if (!deltas.size) return;
      const batch = [...deltas.entries()];
      deltas.clear();
      void write((state) => {
        for (const [id, { value, ephemeral }] of batch) {
          let item = state.items.find((i) => i.id === id);
          if (!item) {
            item = {
              id,
              tipo: "asistente",
              texto: "",
              ephemeral,
              ts: new Date().toISOString(),
            };
            state.items.push(item);
          }
          item.texto += value;
        }
      });
    };

    /**
     * Rejects one open callback and expires its request.
     * @param {string} reqId
     * @param {PendingConversationCallback} cb
     * @param {NativeCallbackStatus} reason
     * @param {string} errMessage
     */
    const closeCallback = (reqId, cb, reason, errMessage) => {
      callbacks.delete(reqId);
      cb.closed = true;
      cb.reject(new Error(errMessage));
      void write((state) => {
        const req = state.requests.find((r) => r.id === reqId);
        if (req && req.status === "pending") expireRequest(req, reason);
      });
    };

    /**
     * @param {NativeCallbackStatus} reason
     * @param {string} errMessage
     */
    const invalidateCallbacks = (reason, errMessage) => {
      for (const [reqId, cb] of [...callbacks.entries()]) {
        closeCallback(reqId, cb, reason, errMessage);
      }
    };

    /**
     * @param {string} targetConnId
     * @param {string} reasonMessage
     */
    const invalidateConnection = (targetConnId, reasonMessage) => {
      connectionDropped = true;
      for (const [reqId, cb] of [...callbacks.entries()]) {
        if (cb.connectionId && cb.connectionId !== targetConnId) continue;
        closeCallback(
          reqId,
          cb,
          "interrupted",
          reasonMessage || "La conexión con el proveedor se cerró",
        );
      }
    };

    const job = {
      turnId,
      connectionId,
      callbacks,
      markDeliveredPendingConfirmation: () => {
        unconfirmedDelivered = true;
      },
      get control() {
        return control;
      },
      invalidateCallbacks,
      invalidateConnection,
      abort: () => {
        aborted = true;
        // Close live callbacks synchronously before signaling child so late answers never race into next turn.
        invalidateCallbacks(
          "interrupted",
          "El turno se interrumpió antes de responder la solicitud",
        );
        for (const fn of aborters) {
          try {
            fn();
          } catch {}
        }
      },
    };
    running.set(session.id, job);

    await write((state) => {
      state.connection = {
        status: "active",
        pid: activeController?.pid?.() ?? null,
        connectionId,
        updatedAt: new Date().toISOString(),
      };
      state.items.push({
        id: randomUUID(),
        tipo: "usuario",
        texto: prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
        ts: new Date().toISOString(),
      });
      pushEvent(state, session.id, {
        type: "turn.started",
        turnId,
        sourceId,
        payload: {
          motor: session.motor,
          modelo: session.modelo ?? null,
          pid: activeController?.pid?.() ?? null,
        },
      });
    });

    /** @type {ConversationContext} */
    const ctx = {
      turnId,
      connectionId,
      session,
      prompt,
      attachments,
      mcpServers,
      cwd,
      env,
      operatorEnv,
      disableInheritedMcp,
      geminiDir,
      acpLogFile,
      settingSources,
      interruptKillGraceMs,
      toolProfile,
      verifiedBillingGrant,
      observeSkills: Boolean(observeSkills || onSkillsObserved),
      onSkillsObserved: async (obs) => {
        if (!obs || !Array.isArray(obs.names)) return;
        await write((state) => {
          state.observedSkills ??= [];
          state.observedSkills.push({
            source: obs.source || "unknown",
            names: [...new Set(obs.names.map(String))],
            ts: new Date().toISOString(),
          });
          pushEvent(state, session.id, {
            type: "skills.observed",
            turnId,
            sourceId: "controller",
            payload: {
              source: obs.source || "unknown",
              names: [...new Set(obs.names.map(String))],
            },
          });
        }).catch(() => {});
        await onSkillsObserved?.(obs);
      },
      spawn,
      nextId: () => ++sequence,
      onAbort: (fn) => aborters.push(fn),
      onControl: (nextControl) => {
        control = { ...control, ...nextControl };
        if (nextControl?.pid && store.state.connection) {
          store.state.connection.pid = nextControl.pid;
        }
      },
      invalidateConnection,
      nativeId: async (id) => {
        if (nativeId === id) return;
        nativeId = id;
        await onNativeId(id);
      },
      message: (id, value) => {
        flushDeltas();
        // Partial SDK items are a transient projection of the same response.
        void write((state) => {
          promoteDelivered(state);
          state.items = state.items.filter((i) => !i.ephemeral);
        });
        void upsert(id, { tipo: "asistente", texto: value });
        void write((state) =>
          pushEvent(state, session.id, {
            type: "message.completed",
            turnId,
            nativeItemId: id,
            sourceId,
            payload: { text: value },
          }),
        );
      },
      delta: (id, value, ephemeral = false) => {
        if (unconfirmedDelivered) {
          void write((state) => promoteDelivered(state));
        }
        const pending = deltas.get(id) || { value: "", ephemeral };
        pending.value += value;
        deltas.set(id, pending);
        deltaTimer ??= setTimeout(flushDeltas, 40);
      },
      tool: (id, value) => {
        flushDeltas();
        if (unconfirmedDelivered) {
          void write((state) => promoteDelivered(state));
        }
        void upsert(id, { tipo: "herramienta", herramienta: value });
        void write((state) =>
          pushEvent(state, session.id, {
            type:
              value.estado === "pendiente" ? "tool.started" : "tool.completed",
            turnId,
            nativeItemId: id,
            sourceId,
            payload: value,
          }),
        );
      },
      artifact: async (artifactInput) => {
        const stored = await storeArtifactBlob(
          persistence.directory,
          session.id,
          artifactInput,
        );
        return write((state) => {
          const entry = artifactEntry(state, session, artifactInput, stored);
          state.artifacts.push(entry);
          pushEvent(state, session.id, {
            type: "artifact.published",
            turnId,
            correlationId: entry.id,
            sourceId: entry.authorId,
            payload: entry,
          });
        });
      },
      event: (ev) =>
        write((state) =>
          pushEvent(state, session.id, { turnId, sourceId, ...ev }),
        ),
      expire: (nativeRequestId) => {
        const pending = [...callbacks.entries()].find(
          ([, value]) => value.nativeId === nativeRequestId,
        );
        if (!pending) return;
        callbacks.delete(pending[0]);
        pending[1].closed = true;
        void write((state) => {
          const req = state.requests.find((r) => r.id === pending[0]);
          if (req) expireRequest(req, "closed_by_turn");
        });
        pending[1].reject(new Error("La solicitud del proveedor venció"));
      },
      ask: (nativeRequestId, request, transportMeta = {}) =>
        new Promise((resolve, reject) => {
          const id = randomUUID();
          callbacks.set(id, {
            resolve,
            reject,
            nativeId: nativeRequestId,
            turnId,
            connectionId: transportMeta.connectionId || connectionId,
            writeAck: transportMeta.writeAck || null,
            callbackAck: transportMeta.callbackAck || null,
            transportMode:
              transportMeta.transportMode ||
              (transportMeta.writeAck ? "rpc_stdio" : "direct"),
            transportObservable:
              transportMeta.transportObservable ??
              Boolean(transportMeta.writeAck),
            isConnectionAlive: transportMeta.isConnectionAlive || null,
            closed: false,
          });
          write((state) => {
            /** @type {ConversationRequest} */
            const record = {
              ...request,
              id,
              nativeId: nativeRequestId,
              turnId,
              connectionId: transportMeta.connectionId || connectionId,
              status: "pending",
              nativeCallbackStatus: "open",
              ...(request.kind === "question"
                ? { productStatus: "pendiente", requiresNewTurn: false }
                : {}),
              createdAt: new Date().toISOString(),
            };
            state.requests.push(record);
            pushEvent(state, session.id, {
              type:
                request.kind === "approval"
                  ? "approval.created"
                  : "user_request.created",
              turnId,
              correlationId: id,
              sourceId,
              payload: record,
            });
          }).catch(reject);
        }),
    };

    let adapterOutcome = { status: "completed" };
    /** @type {Error | null} */
    let turnError = null;
    try {
      const outcome = activeController
        ? await activeController.runTurn(ctx)
        : await adapter(ctx);
      if (outcome && typeof outcome === "object" && outcome.status) {
        adapterOutcome = outcome;
      }
      flushDeltas();
      await pendingWrite;
      if (persistenceError) throw persistenceError;
    } catch (error) {
      turnError = error;
      if (activeController && !activeController.isAlive()) {
        controllers.delete(session.id);
      }
      throw error;
    } finally {
      flushDeltas();
      const closeReason =
        aborted || connectionDropped
          ? "interrupted"
          : turnError
            ? "expired"
            : "closed_by_turn";
      invalidateCallbacks(
        closeReason,
        "El proveedor cerró la solicitud al finalizar el turno",
      );
      running.delete(session.id);
      const stillAlive = Boolean(activeController?.isAlive());
      if (activeController && !stillAlive) {
        controllers.delete(session.id);
      }
      const finalStatus = aborted
        ? "interrupted"
        : turnError
          ? "failed"
          : adapterOutcome.status === "interrupted"
            ? "interrupted"
            : "completed";
      await write((state) => {
        if (finalStatus === "completed") {
          promoteDelivered(state);
        } else if (unconfirmedDelivered) {
          reconcileUnconfirmedCallbacks(
            state,
            receiptTurn,
            turnError?.message ||
              "El proveedor cerró el turno sin confirmar el consumo del callback.",
          );
          unconfirmedDelivered = false;
        }
        state.lastTurnStatus = finalStatus;
        if (activeController) {
          state.connection = {
            status: stillAlive ? "idle" : "closed",
            pid: stillAlive ? activeController.pid() : null,
            connectionId,
            reason: stillAlive
              ? "Proceso persistente en espera del siguiente turno"
              : "Proceso finalizado",
            updatedAt: new Date().toISOString(),
          };
        }
        pushEvent(state, session.id, {
          type:
            finalStatus === "completed"
              ? "turn.completed"
              : finalStatus === "interrupted"
                ? "turn.interrupted"
                : "turn.failed",
          turnId,
          sourceId,
          payload: {
            status: finalStatus,
            ...(activeController
              ? {
                  pid: stillAlive ? activeController.pid() : null,
                  persistent: stillAlive,
                }
              : {}),
            ...(turnError ? { error: turnError.message } : {}),
          },
        });
      });
      await pendingWrite;
    }
    const state = await snapshot(session.id);
    return (
      state.items.filter((i) => i.tipo === "asistente").at(-1)?.texto || ""
    );
  };
}
