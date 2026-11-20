// @ts-check
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROVIDER_ADAPTERS,
  validateAndExtractElicitationContent,
} from "./provider-adapters.mjs";
import { ErrorLanzador } from "./errores.mjs";
import { sha256Hex } from "./lib/hash.mjs";

export const MESSAGE_DELIVERY_STATUSES = new Set([
  "recibido",
  "en_cola",
  "entregado",
  "confirmado_proveedor",
  "fallido",
  "entrega_incierta",
]);

export const REQUEST_DELIVERY_STATUSES = new Set([
  "respuesta_recibida",
  "entregando",
  "entregada",
  "confirmada",
  "entrega_incierta",
]);

const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id);

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function ensureStateShape(state) {
  state.seq ??= 0;
  state.items ??= [];
  state.requests ??= [];
  state.receipts ??= [];
  state.commands ??= [];
  state.queue ??= [];
  state.artifacts ??= [];
  state.events ??= [];
  state.eventSeq ??= state.events.length;
  state.lastTurnStatus ??= null;
  state.connection ??= null;
  return state;
}

/** Durable protocol events, commands, queues, artifacts, and requests; zero PTY/transcript inference. */
export function createProviderConversations({
  directory,
  adapters = PROVIDER_ADAPTERS,
  onEvent = /** @type {(...args: any[]) => any} */ (() => {}),
}) {
  const stores = new Map();
  const running = new Map();
  const controllers = new Map();

  async function load(id) {
    if (!validId(id)) throw new ErrorLanzador("Sesión inválida.", 400);
    if (!stores.has(id))
      stores.set(
        id,
        (async () => {
          let state;
          const filename = path.join(directory, `${id}.json`);
          try {
            state = ensureStateShape(
              JSON.parse(await readFile(filename, "utf8")),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            state = ensureStateShape({});
          }
          // A callback belongs strictly to its live process, never across restarts.
          let changed = false;
          for (const request of state.requests) {
            if (request.status === "pending") {
              request.status = "expired";
              request.nativeCallbackStatus = "interrupted";
              if (request.kind === "question") {
                request.productStatus = "pendiente";
                request.requiresNewTurn = true;
              }
              changed = true;
            }
          }
          const store = {
            state,
            filename,
            listeners: new Set(),
            queue: Promise.resolve(),
          };
          if (changed) await save(store);
          return store;
        })(),
      );
    return stores.get(id);
  }

  function save(store) {
    const content = JSON.stringify(store.state);
    const write = store.queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(store.filename + ".tmp", content, { mode: 0o600 });
      await rename(store.filename + ".tmp", store.filename);
      for (const listener of store.listeners) {
        try {
          listener();
        } catch {
          /* An observer cannot undo persistence. */
        }
      }
    });
    store.queue = write.catch(() => {});
    return write;
  }

  function pushEvent(state, sessionId, ev) {
    const event = {
      id: ev.id || randomUUID(),
      sequence: ++state.eventSeq,
      sessionId,
      turnId: ev.turnId ?? null,
      nativeItemId: ev.nativeItemId ?? null,
      correlationId: ev.correlationId ?? null,
      sourceId: ev.sourceId ?? "provider",
      type: ev.type,
      timestamp: new Date().toISOString(),
      payloadVersion: 1,
      payload: ev.payload ?? {},
    };
    state.events.push(event);
    if (state.events.length > 2000) {
      state.events = state.events.slice(-2000);
    }
    try {
      onEvent(sessionId, event);
    } catch {
      /* External listeners must not abort persistence. */
    }
    return event;
  }

  function change(store, fn) {
    fn(store.state);
    store.state.seq++;
    store.state.updatedAt = new Date().toISOString();
    return save(store);
  }

  async function snapshot(id) {
    const store = await load(id);
    await store.queue;
    return structuredClone(store.state);
  }

  async function shutdownController(
    id,
    { reason = "Cierre explícito" } = /** @type {any} */ ({}),
  ) {
    const entry = controllers.get(id);
    if (!entry) return { closed: false, id, pid: null };
    const oldPid = entry.controller.pid();
    controllers.delete(id);
    const liveJob = running.get(id);
    if (liveJob) {
      liveJob.invalidateCallbacks("interrupted", reason);
    }
    try {
      await entry.controller.shutdown(reason);
    } catch {
      /* ensure cleanup proceeds even on dead child */
    }
    const store = await load(id).catch(() => null);
    if (store) {
      const evicted = /evic|límite|recurso/i.test(reason);
      const nextConn = {
        status: evicted ? "evicted" : "closed",
        pid: null,
        connectionId: entry.controller.connectionId,
        reason,
        updatedAt: new Date().toISOString(),
      };
      await change(store, (state) => {
        state.connection = nextConn;
        pushEvent(state, id, {
          type: "connection.status",
          sourceId: "controller",
          payload: nextConn,
        });
      }).catch(() => {});
    }
    return { closed: true, id, pid: oldPid, reason };
  }

  async function shutdownAll(reason = "Apagado del lanzador") {
    const ids = [...controllers.keys()];
    await Promise.allSettled(
      ids.map((id) => shutdownController(id, { reason })),
    );
  }

  async function evictOldestIdle(
    reason = "Cerrada por límite de procesos activos",
    excludeIds = [],
  ) {
    const blocked = new Set(excludeIds);
    const candidates = [...controllers.entries()]
      .filter(
        ([id, entry]) =>
          !blocked.has(id) && !running.has(id) && entry.controller.isAlive(),
      )
      .sort((a, b) => a[1].controller.lastUsedAt - b[1].controller.lastUsedAt);
    if (candidates.length === 0) return null;
    const [victimId] = candidates[0];
    return shutdownController(victimId, { reason });
  }

  function hasLiveController(id) {
    return Boolean(controllers.get(id)?.controller?.isAlive());
  }

  function liveSessions() {
    const items = [];
    for (const [id, entry] of controllers.entries()) {
      if (!entry.controller.isAlive()) {
        controllers.delete(id);
        continue;
      }
      items.push({
        id,
        motor: entry.controller.motor,
        pid: entry.controller.pid(),
        connectionId: entry.controller.connectionId,
        state: running.has(id) ? "ocupado" : "ocioso",
        lastUsedAt: entry.controller.lastUsedAt,
        createdAt: entry.controller.createdAt,
        capabilities: entry.controller.capabilities?.() || {},
      });
    }
    return items;
  }

  function capabilities(idOrMotor) {
    const entry = controllers.get(idOrMotor);
    if (entry?.controller?.capabilities) {
      return entry.controller.capabilities();
    }
    if (adapters[idOrMotor]?.createController) {
      const tmp = adapters[idOrMotor].createController();
      return tmp.capabilities?.() || {};
    }
    return {
      persistentProcess: false,
      supportsSteer: false,
      supportsInterrupt: false,
      supportsResume: false,
    };
  }

  async function run({
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
    const store = await load(session.id);
    const turnId = randomUUID();
    const callbacks = new Map();
    const aborters = [];
    let control = { supportsSteer: false };
    let nativeId = session.conversacionId;
    let sequence = 0;
    let aborted = false;
    let connectionDropped = false;
    let pendingWrite = Promise.resolve();
    let persistenceError;
    let activeController = null;
    let unconfirmedDelivered = false;

    const configSignature = canonicalStringify({
      motor: session.motor,
      modelo: session.modelo ?? null,
      esfuerzo: session.esfuerzo ?? null,
      cwd,
      mcpServers: mcpServers === undefined ? "undefined" : mcpServers,
      geminiDir,
      disableInheritedMcp,
      toolProfileId: toolProfile?.id ?? null,
    });

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

    const write = (fn) => {
      const next = pendingWrite.then(() => change(store, fn));
      pendingWrite = next.catch((error) => {
        persistenceError = error;
      });
      return next;
    };

    const promoteDeliveredReceipts = (state) => {
      if (!unconfirmedDelivered) return;
      let stillPending = false;
      const now = new Date().toISOString();
      for (const r of state.receipts) {
        if (
          (r.status === "entregada" ||
            (r.status === "entregando" && r.callbackReturned === true)) &&
          r.turnId === turnId &&
          (!r.connectionId || r.connectionId === connectionId)
        ) {
          r.status = "confirmada";
          r.delivered = true;
          r.harnessConfirmedAt = now;
          if (r.transportMode === "sdk_callback_return") {
            r.transportEvidence = "harness_progress";
          }
          const req = state.requests.find((x) => x.id === r.requestId);
          if (req && req.kind === "question") {
            req.productStatus = "confirmada";
          }
          pushEvent(state, session.id, {
            type: "user_request.delivery",
            turnId,
            correlationId: r.requestId,
            sourceId: "provider",
            payload: structuredClone(r),
          });
        } else if (
          r.status === "entregada" ||
          (r.status === "entregando" && r.callbackReturned === true)
        ) {
          stillPending = true;
        }
      }
      unconfirmedDelivered = stillPending;
    };

    const reconcileUnconfirmedCallbacks = (state, reasonMessage) => {
      for (const r of state.receipts) {
        if (
          r.turnId === turnId &&
          (!r.connectionId || r.connectionId === connectionId) &&
          (r.status === "entregando" ||
            (r.status === "entregada" && !r.harnessConfirmedAt))
        ) {
          r.status = "entrega_incierta";
          r.delivered = false;
          r.error =
            r.error ||
            reasonMessage ||
            "El turno terminó sin confirmar recepción en el proveedor.";
          const req = state.requests.find((x) => x.id === r.requestId);
          if (req && req.kind === "question") {
            req.productStatus = "entrega_incierta";
          }
          pushEvent(state, session.id, {
            type: "user_request.delivery",
            turnId,
            correlationId: r.requestId,
            sourceId: "provider",
            payload: structuredClone(r),
          });
        }
      }
      unconfirmedDelivered = false;
    };

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

    const deltas = new Map();
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

    const invalidateCallbacks = (reason, errMessage) => {
      if (callbacks.size === 0) return;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [reqId, cb] of pending) {
        cb.closed = true;
        cb.reject(new Error(errMessage));
        void write((state) => {
          const req = state.requests.find((r) => r.id === reqId);
          if (req && req.status === "pending") {
            req.status = "expired";
            req.nativeCallbackStatus = reason;
            if (req.kind === "question") {
              req.productStatus = "pendiente";
              req.requiresNewTurn = true;
            }
          }
        });
      }
    };

    const invalidateConnection = (targetConnId, reasonMessage) => {
      connectionDropped = true;
      for (const [reqId, cb] of [...callbacks.entries()]) {
        if (cb.connectionId && cb.connectionId !== targetConnId) continue;
        callbacks.delete(reqId);
        cb.closed = true;
        cb.reject(
          new Error(reasonMessage || "La conexión con el proveedor se cerró"),
        );
        void write((state) => {
          const req = state.requests.find((r) => r.id === reqId);
          if (req && req.status === "pending") {
            req.status = "expired";
            req.nativeCallbackStatus = "interrupted";
            if (req.kind === "question") {
              req.productStatus = "pendiente";
              req.requiresNewTurn = true;
            }
          }
        });
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
        sourceId: session.memberId || session.motor,
        payload: {
          motor: session.motor,
          modelo: session.modelo ?? null,
          pid: activeController?.pid?.() ?? null,
        },
      });
    });

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
          promoteDeliveredReceipts(state);
          state.items = state.items.filter((i) => !i.ephemeral);
        });
        void upsert(id, { tipo: "asistente", texto: value });
        void write((state) =>
          pushEvent(state, session.id, {
            type: "message.completed",
            turnId,
            nativeItemId: id,
            sourceId: session.memberId || session.motor,
            payload: { text: value },
          }),
        );
      },
      delta: (id, value, ephemeral = false) => {
        if (unconfirmedDelivered) {
          void write((state) => promoteDeliveredReceipts(state));
        }
        const pending = deltas.get(id) || { value: "", ephemeral };
        pending.value += value;
        deltas.set(id, pending);
        deltaTimer ??= setTimeout(flushDeltas, 40);
      },
      tool: (id, value) => {
        flushDeltas();
        if (unconfirmedDelivered) {
          void write((state) => promoteDeliveredReceipts(state));
        }
        void upsert(id, { tipo: "herramienta", herramienta: value });
        void write((state) =>
          pushEvent(state, session.id, {
            type:
              value.estado === "pendiente" ? "tool.started" : "tool.completed",
            turnId,
            nativeItemId: id,
            sourceId: session.memberId || session.motor,
            payload: value,
          }),
        );
      },
      artifact: async (artifactInput) => {
        const fileRef = String(artifactInput.fileRef || "").replace(/\\/g, "/");
        if (!fileRef || fileRef.includes("..") || path.isAbsolute(fileRef)) {
          throw new Error(
            "El artefacto requiere ruta relativa válida (fileRef).",
          );
        }
        const id = artifactInput.id || randomUUID();
        if (!validId(id)) {
          throw new Error("Identificador de artefacto inválido.");
        }
        const buf = Buffer.isBuffer(artifactInput.contentBuffer)
          ? artifactInput.contentBuffer
          : artifactInput.content !== undefined
            ? Buffer.from(String(artifactInput.content), "utf8")
            : null;
        let sha256 = String(artifactInput.sha256 || "");
        if (buf !== null) {
          const computed = sha256Hex(buf);
          if (sha256 && sha256 !== computed) {
            throw new Error("SHA-256 del artefacto no coincide con sus bytes.");
          }
          sha256 = computed;
          const blobDir = path.join(directory, "_blobs", session.id);
          await mkdir(blobDir, { recursive: true, mode: 0o700 });
          const blobPath = path.join(blobDir, `${id}.bin`);
          const tmpBlob = path.join(
            blobDir,
            `${id}.${process.pid}.${Date.now()}.tmp`,
          );
          await writeFile(tmpBlob, buf, { mode: 0o600 });
          await rename(tmpBlob, blobPath);
        }
        return write((state) => {
          const existingMax = state.artifacts
            .filter((a) => a.fileRef === fileRef)
            .reduce((max, a) => Math.max(max, a.version || 0), 0);
          const entry = {
            id,
            artifactId: id,
            workOrderId: session.workOrderId ?? null,
            sessionId: session.id,
            authorId: session.memberId || session.motor,
            fileRef,
            fileName: artifactInput.fileName || path.basename(fileRef),
            sha256,
            hash: sha256,
            bytesLength:
              buf !== null ? buf.length : (artifactInput.byteLength ?? 0),
            mimeType: artifactInput.mimeType || "application/octet-stream",
            version: artifactInput.version ?? existingMax + 1,
            evidenceRefs: Array.isArray(artifactInput.evidenceRefs)
              ? artifactInput.evidenceRefs.map(String)
              : [],
            summary: String(artifactInput.summary || ""),
            comment: String(
              artifactInput.comment || artifactInput.summary || "",
            ),
            immutable: buf !== null,
            verification: "pendiente",
            createdAt: new Date().toISOString(),
          };
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
          pushEvent(state, session.id, {
            turnId,
            sourceId: session.memberId || session.motor,
            ...ev,
          }),
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
          if (req) {
            req.status = "expired";
            req.nativeCallbackStatus = "closed_by_turn";
            if (req.kind === "question") {
              req.productStatus = "pendiente";
              req.requiresNewTurn = true;
            }
          }
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
              sourceId: session.memberId || session.motor,
              payload: record,
            });
          }).catch(reject);
        }),
    };

    let adapterOutcome = { status: "completed" };
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
          promoteDeliveredReceipts(state);
        } else if (unconfirmedDelivered) {
          reconcileUnconfirmedCallbacks(
            state,
            turnError?.message ||
              "El proveedor cerró el turno sin confirmar el consumo del callback.",
          );
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
          sourceId: session.memberId || session.motor,
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
  }

  async function sendMessage(
    id,
    {
      clientMessageId,
      text = "",
      mode = "send",
      attachments = [],
      online = true,
      // The caller still holds the session: a turn this layer has already
      // finished must not leave the message accepted but never delivered.
      queueIfIdle = false,
    } = /** @type {any} */ ({}),
  ) {
    if (!clientMessageId || typeof clientMessageId !== "string") {
      throw new ErrorLanzador("clientMessageId inválido.", 400);
    }
    if (!["send", "steer", "queue"].includes(mode)) {
      throw new ErrorLanzador("Modo de envío inválido.", 400);
    }
    if (!String(text || "").trim() && attachments.length === 0) {
      throw new ErrorLanzador("El mensaje no puede estar vacío.", 400);
    }
    const store = await load(id);
    await store.queue;
    const existing = store.state.commands.find(
      (c) => c.clientMessageId === clientMessageId,
    );
    if (existing) {
      return {
        command: structuredClone(existing),
        repetido: true,
        queued: existing.deliveryStatus === "en_cola",
      };
    }

    const now = new Date().toISOString();
    const command = {
      id: randomUUID(),
      clientMessageId,
      mode,
      text: String(text || "").trim(),
      attachments: structuredClone(attachments),
      deliveryStatus: "recibido",
      turnId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    const job = running.get(id);
    if (
      !online ||
      (!job && queueIfIdle) ||
      (job &&
        (mode === "queue" || mode === "send" || !job.control?.supportsSteer))
    ) {
      command.deliveryStatus = "en_cola";
      const queueItem = {
        commandId: command.id,
        clientMessageId: command.clientMessageId,
        text: command.text,
        attachments: command.attachments,
        deliveryStatus: "en_cola",
        createdAt: now,
      };
      await change(store, (state) => {
        state.commands.push(command);
        state.queue.push(queueItem);
        pushEvent(state, id, {
          type: "message.queued",
          correlationId: command.id,
          sourceId: "app",
          payload: {
            commandId: command.id,
            clientMessageId,
            deliveryStatus: "en_cola",
            requestedMode: mode,
            fallbackToQueue: mode === "steer",
          },
        });
      });
      return {
        command: structuredClone(command),
        modo: "queue",
        queued: true,
        repetido: false,
      };
    }

    if (job && mode === "steer" && job.control?.supportsSteer) {
      command.turnId = job.turnId;
      await change(store, (state) => {
        state.commands.push(command);
        pushEvent(state, id, {
          type: "message.accepted",
          turnId: job.turnId,
          correlationId: command.id,
          sourceId: "app",
          payload: {
            commandId: command.id,
            clientMessageId,
            deliveryStatus: "recibido",
            mode: "steer",
          },
        });
      });
      try {
        await job.control.steer(command.text, command.attachments);
        await change(store, (state) => {
          const target = state.commands.find((c) => c.id === command.id);
          target.deliveryStatus = "confirmado_proveedor";
          target.updatedAt = new Date().toISOString();
          state.items.push({
            id: randomUUID(),
            tipo: "usuario",
            texto: command.text,
            mode: "steer",
            ts: target.updatedAt,
          });
        });
        return {
          command: structuredClone(
            store.state.commands.find((c) => c.id === command.id),
          ),
          modo: "steer",
          queued: false,
          repetido: false,
        };
      } catch (err) {
        await change(store, (state) => {
          const target = state.commands.find((c) => c.id === command.id);
          target.deliveryStatus = "entrega_incierta";
          target.error = err?.message || "Fallo al confirmar redirección";
          target.updatedAt = new Date().toISOString();
        });
        return {
          command: structuredClone(
            store.state.commands.find((c) => c.id === command.id),
          ),
          modo: "steer",
          queued: false,
          repetido: false,
        };
      }
    }

    await change(store, (state) => {
      state.commands.push(command);
      pushEvent(state, id, {
        type: "message.accepted",
        correlationId: command.id,
        sourceId: "app",
        payload: {
          commandId: command.id,
          clientMessageId,
          deliveryStatus: "recibido",
          mode,
        },
      });
    });
    return {
      command: structuredClone(command),
      modo: mode,
      queued: false,
      repetido: false,
    };
  }

  async function markCommandDelivery(
    id,
    commandId,
    deliveryStatus,
    error = null,
  ) {
    if (!MESSAGE_DELIVERY_STATUSES.has(deliveryStatus)) {
      throw new ErrorLanzador("Estado de entrega inválido.", 400);
    }
    const store = await load(id);
    await store.queue;
    let updated = null;
    await change(store, (state) => {
      const cmd = state.commands.find(
        (c) => c.id === commandId || c.clientMessageId === commandId,
      );
      if (!cmd) throw new ErrorLanzador("Comando no encontrado.", 404);
      cmd.deliveryStatus = deliveryStatus;
      cmd.error = error;
      cmd.updatedAt = new Date().toISOString();
      updated = cmd;
    });
    return structuredClone(updated);
  }

  async function listQueue(id) {
    const store = await load(id);
    await store.queue;
    return structuredClone(store.state.queue);
  }

  async function cancelQueuedMessage(id, clientMessageId) {
    const store = await load(id);
    await store.queue;
    const idx = store.state.queue.findIndex(
      (q) =>
        q.clientMessageId === clientMessageId ||
        q.commandId === clientMessageId,
    );
    if (idx === -1) {
      throw new ErrorLanzador(
        "El mensaje ya fue entregado o no está en la cola.",
        409,
      );
    }
    let cancelled = null;
    await change(store, (state) => {
      const [removed] = state.queue.splice(idx, 1);
      const cmd = state.commands.find((c) => c.id === removed.commandId);
      if (cmd) {
        cmd.deliveryStatus = "fallido";
        cmd.cancelled = true;
        cmd.error = "Cancelado de la cola antes de entregarse.";
        cmd.updatedAt = new Date().toISOString();
        cancelled = cmd;
      }
    });
    return { ok: true, command: structuredClone(cancelled) };
  }

  async function consumeNextQueuedMessage(id) {
    const store = await load(id);
    await store.queue;
    if (store.state.queue.length === 0) return null;
    let nextItem = null;
    await change(store, (state) => {
      nextItem = state.queue.shift() || null;
      if (nextItem) {
        const cmd = state.commands.find((c) => c.id === nextItem.commandId);
        if (cmd) {
          cmd.deliveryStatus = "entregado";
          cmd.updatedAt = new Date().toISOString();
        }
      }
    });
    return structuredClone(nextItem);
  }

  return {
    run,
    snapshot,
    sendMessage,
    markCommandDelivery,
    listQueue,
    cancelQueuedMessage,
    consumeNextQueuedMessage,
    hasLiveController,
    liveSessions,
    capabilities,
    shutdown: shutdownController,
    shutdownAll,
    evictOldestIdle,
    async readArtifact(sessionId, artifactId) {
      if (!validId(sessionId) || !validId(artifactId)) {
        throw new ErrorLanzador("Identificador de artefacto inválido.", 400);
      }
      const store = await load(sessionId);
      await store.queue;
      const entry = store.state.artifacts.find((a) => a.id === artifactId);
      if (!entry) {
        throw new ErrorLanzador("Artefacto no encontrado.", 404);
      }
      const blobPath = path.join(
        directory,
        "_blobs",
        sessionId,
        `${artifactId}.bin`,
      );
      let buffer;
      try {
        buffer = await readFile(blobPath);
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new ErrorLanzador(
            "Los bytes inmutables de esta versión no están disponibles.",
            404,
          );
        }
        throw err;
      }
      const actualHash = sha256Hex(buffer);
      if (entry.sha256 && actualHash !== entry.sha256) {
        throw new ErrorLanzador(
          "Verificación SHA-256 del artefacto fallida.",
          500,
        );
      }
      return { artifact: structuredClone(entry), buffer };
    },
    async remove(id) {
      if (running.has(id))
        throw new ErrorLanzador("Detén la sesión antes de eliminarla", 409);
      if (controllers.has(id)) {
        await shutdownController(id, { reason: "Conversación eliminada" });
      }
      const store = await load(id);
      await store.queue;
      await rm(store.filename, { force: true });
      await rm(path.join(directory, "_blobs", id), {
        recursive: true,
        force: true,
      }).catch(() => {});
      stores.delete(id);
    },
    abort: (id) => running.get(id)?.abort(),
    async subscribe(id, listener) {
      const store = await load(id);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    async answer(id, { requestId, responseId, answers, decision, content }) {
      if (!validId(requestId) || !validId(responseId))
        throw new ErrorLanzador("Respuesta inválida.", 400);
      const store = await load(id);
      await store.queue;
      const incomingAnswer = {
        ...(answers !== undefined ? { answers } : {}),
        ...(decision !== undefined ? { decision } : {}),
        ...(content !== undefined ? { content } : {}),
      };
      const receipt = store.state.receipts.find(
        (r) => r.responseId === responseId,
      );
      if (receipt) {
        if (
          receipt.requestId !== requestId ||
          canonicalStringify(receipt.answer) !==
            canonicalStringify(incomingAnswer)
        )
          throw new ErrorLanzador("Conflicto de respuesta.", 409);
        return structuredClone(receipt);
      }
      const request = store.state.requests.find((r) => r.id === requestId);
      const liveJob = running.get(id);
      const callback = liveJob?.callbacks.get(requestId);
      if (
        !request ||
        request._claiming ||
        !callback ||
        callback.closed ||
        callback.turnId !== request.turnId ||
        callback.connectionId !== request.connectionId ||
        request.status !== "pending" ||
        request.nativeCallbackStatus !== "open"
      )
        throw new ErrorLanzador("La solicitud ya no está vigente.", 409);
      if (callback.isConnectionAlive && !callback.isConnectionAlive()) {
        callback.closed = true;
        liveJob.callbacks.delete(requestId);
        await change(store, () => {
          request.status = "expired";
          request.nativeCallbackStatus = "interrupted";
          if (request.kind === "question") {
            request.productStatus = "pendiente";
            request.requiresNewTurn = true;
          }
        }).catch(() => {});
        throw new ErrorLanzador(
          "La conexión con el proveedor cerró antes de enviar la respuesta.",
          409,
        );
      }
      if (request.kind === "approval") {
        if (!request.choices?.includes(decision)) {
          throw new ErrorLanzador("Decisión inválida.", 400);
        }
        if (
          decision === "accept" &&
          (request.requestedSchema !== undefined ||
            request.mode !== undefined ||
            content !== undefined)
        ) {
          validateAndExtractElicitationContent(
            request.requestedSchema,
            content,
            request.mode || "form",
          );
        }
      }
      if (
        request.kind === "question" &&
        (!answers ||
          typeof answers !== "object" ||
          Array.isArray(answers) ||
          (request.questions || []).some((q) => {
            const val = answers[q.id];
            if (Array.isArray(val)) return val.length === 0;
            return typeof val !== "string" || !val.trim();
          }))
      )
        throw new ErrorLanzador("Completa todas las respuestas.", 400);

      // Step 1: Claim synchronously and persist answer durably ("respuesta_recibida") BEFORE dispatch.
      request._claiming = true;
      const result = {
        requestId,
        responseId,
        turnId: request.turnId ?? null,
        connectionId: callback.connectionId ?? null,
        answer: structuredClone(incomingAnswer),
        status: "respuesta_recibida",
        delivered: false,
        transportEvidence: null,
      };
      request.status = "answered";
      request.nativeCallbackStatus = "responded";
      if (request.kind === "question") {
        request.productStatus = "respuesta_recibida";
      }
      try {
        await change(store, (state) => {
          state.receipts.push(result);
          request.answer = structuredClone(incomingAnswer);
          pushEvent(state, id, {
            type:
              request.kind === "approval"
                ? "approval.resolved"
                : "user_request.resolved",
            turnId: request.turnId ?? null,
            correlationId: requestId,
            sourceId: "app",
            payload: structuredClone(result),
          });
        });
      } catch (error) {
        request.status = "pending";
        request.nativeCallbackStatus = "open";
        if (request.kind === "question") request.productStatus = "pendiente";
        store.state.receipts = store.state.receipts.filter((r) => r !== result);
        delete request.answer;
        delete request._claiming;
        throw error;
      }
      delete request._claiming;

      // Step 2: Transition to "entregando" and dispatch to live protocol callback
      await change(store, () => {
        result.status = "entregando";
        if (request.kind === "question") {
          request.productStatus = "entregando";
        }
      });

      liveJob.callbacks.delete(requestId);
      const replyPayload =
        request.kind === "question"
          ? answers
          : {
              decision,
              ...(content !== undefined
                ? { content: structuredClone(content) }
                : {}),
            };
      callback.resolve(replyPayload);

      // Step 3: Verify transport flush (without assuming harness consumption until progress)
      if (callback.writeAck) {
        try {
          await callback.writeAck;
          liveJob.markDeliveredPendingConfirmation?.();
          await change(store, (state) => {
            result.status = "entregada";
            result.delivered = true;
            result.transportObservable = true;
            result.transportEvidence = "rpc_write_flushed";
            if (request.kind === "question") {
              request.productStatus = "entregada";
            }
            pushEvent(state, id, {
              type: "user_request.delivery",
              turnId: request.turnId ?? null,
              correlationId: requestId,
              sourceId: "provider",
              payload: structuredClone(result),
            });
          });
        } catch (writeErr) {
          await change(store, (state) => {
            result.status = "entrega_incierta";
            result.delivered = false;
            result.transportObservable = true;
            result.transportEvidence = null;
            result.error =
              writeErr?.message ||
              "Conexión caída o error enviando respuesta al proveedor.";
            request.nativeCallbackStatus = "interrupted";
            if (request.kind === "question") {
              request.productStatus = "entrega_incierta";
            }
            pushEvent(state, id, {
              type: "user_request.delivery",
              turnId: request.turnId ?? null,
              correlationId: requestId,
              sourceId: "provider",
              payload: structuredClone(result),
            });
          });
        }
      } else if (callback.transportMode === "sdk_callback_return") {
        try {
          await callback.callbackAck;
          liveJob.markDeliveredPendingConfirmation?.();
          await change(store, (state) => {
            // Claude SDK callbacks return a Promise to the SDK without an OS pipe write-flush ack.
            result.status = "entregando";
            result.callbackReturned = true;
            result.delivered = false;
            result.transportObservable = false;
            result.transportMode = "sdk_callback_return";
            result.transportEvidence = "callback_returned";
            result.transportLimit =
              "El SDK de Claude no expone acuse de escritura en transporte; pendiente de progreso posterior del agente.";
            if (request.kind === "question") {
              request.productStatus = "entregando";
            }
            pushEvent(state, id, {
              type: "user_request.delivery",
              turnId: request.turnId ?? null,
              correlationId: requestId,
              sourceId: "provider",
              payload: structuredClone(result),
            });
          });
        } catch (sdkErr) {
          await change(store, (state) => {
            result.status = "entrega_incierta";
            result.callbackReturned = false;
            result.delivered = false;
            result.transportObservable = false;
            result.transportMode = "sdk_callback_return";
            result.transportEvidence = null;
            result.error =
              sdkErr?.message ||
              "La sesión del SDK de Claude se cerró antes de confirmar la devolución del callback.";
            request.nativeCallbackStatus = "interrupted";
            if (request.kind === "question") {
              request.productStatus = "entrega_incierta";
            }
            pushEvent(state, id, {
              type: "user_request.delivery",
              turnId: request.turnId ?? null,
              correlationId: requestId,
              sourceId: "provider",
              payload: structuredClone(result),
            });
          });
        }
      } else {
        liveJob.markDeliveredPendingConfirmation?.();
        await change(store, () => {
          result.status = "entregada";
          result.delivered = true;
          result.transportEvidence = "callback_resolved";
          if (request.kind === "question") {
            request.productStatus = "entregada";
          }
        });
      }
      return structuredClone(result);
    },
  };
}

export async function serveProviderConversation({
  res,
  id,
  conversations,
  registro,
}) {
  const session = registro.leer().find((s) => s.id === id && !s.eliminada);
  if (!session?.structured)
    throw new ErrorLanzador("Conversación estructurada no disponible.", 409);
  let closed = false;
  let pending = Promise.resolve();
  const send = () => {
    pending = pending
      .then(async () => {
        const state = await conversations.snapshot(id);
        if (closed) return;
        if (res.writableLength > 4 * 1024 * 1024) return res.end();
        const current = registro.leer().find((s) => s.id === id);
        res.write(
          `event: conversation\ndata: ${JSON.stringify({ ...state, status: current?.estado, error: current?.error })}\n\n`,
        );
      })
      .catch(() => res.end());
  };
  const off = await conversations.subscribe(id, send);
  const offRegistry = registro.subscribe(send);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  heartbeat.unref();
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    off();
    offRegistry();
  });
  send();
}
