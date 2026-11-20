// The session executor. Each concern lives in launcher/execution/; what stays
// here is the turn orchestration (launch, release, resource queue, message
// queue), whose functions call one another.
import { validateEngineAttachments } from "./engines.mjs";
import { stopSessionScope } from "./limits.mjs";
import { LauncherError } from "./errors.mjs";
import { resolveExecutorOptions } from "./execution/options.mjs";
import { createExecutionState } from "./execution/state.mjs";
import { createLifecycle } from "./execution/lifecycle.mjs";
import { createDelegation } from "./execution/delegation.mjs";
import { createConversationQueue } from "./execution/conversation-queue.mjs";
import { createTerminalIo } from "./execution/terminal-io.mjs";
import { createStarter } from "./execution/start.mjs";
import { createRemoteRunner } from "./execution/run-remote.mjs";
import { createLocalRunner } from "./execution/run-local.mjs";
import { createMonitor } from "./execution/monitor.mjs";
import { createCapacity } from "./execution/capacity.mjs";
import { createSessionSecrets } from "./execution/secrets.mjs";
import { createProcessTools } from "./execution/process-tools.mjs";

/** @import { LauncherSession } from "./session-types.d.ts" */
/** @import { ActiveJob, ExecutorOptions, TurnOptions } from "./types.d.ts" */

/** @param {ExecutorOptions} options */
export function createExecutor(options) {
  const config = resolveExecutorOptions(options);
  const {
    registro,
    proyectos: projects,
    env,
    maxActivos: maxActive,
    conversations,
  } = config;
  const state = createExecutionState();
  const {
    activos: active,
    liveProcesses,
    resourceQueue,
    queuedPromises,
    serial,
    drenando: draining,
  } = state;
  const {
    sessionTokenDir,
    sanitizeChildEnv,
    acpGeminiDirFor,
    copiarEntradasProyecto: copyProjectEntries,
    limpiarWorkspaceMiembro: cleanMemberWorkspace,
    senalar: signal,
    marcar: mark,
    margenDiagnostico: diagnosticMargin,
    diagnosticar: diagnose,
  } = createProcessTools(config);
  const {
    writeSessionTokenFile,
    cleanupSessionRuntimeSecrets,
    resolveSessionEffectiveProfile,
  } = createSessionSecrets(config, state, { sessionTokenDir });
  const {
    limpiarEviccionOciosa: cleanIdleEviction,
    armarEviccionOciosa: buildIdleEviction,
    sesionesOcupandoCupo: sessionsOccupyingSlot,
    cerrarConexion: closeConnection,
    evictOneIdle,
    asegurarCupo: ensureSlot,
    cerrarTodo: closeAll,
  } = createCapacity(config, state, {
    acpGeminiDirFor,
    cleanupSessionRuntimeSecrets,
  });
  async function dispatchResourcesQueue() {
    while (resourceQueue.length > 0) {
      if (sessionsOccupyingSlot().size >= maxActive) {
        const evicted = await evictOneIdle(
          "Evictada para iniciar una integrante en cola",
        );
        if (!evicted) break;
      }
      const next = resourceQueue.shift();
      if (!next) break;
      const s = registro.leer().find((x) => x.id === next.sesionId);
      const pq = queuedPromises.get(next.sesionId);
      if (!s || s.eliminada || s.estado !== "pendiente") {
        if (pq) {
          queuedPromises.delete(next.sesionId);
          pq.resolve();
        }
        continue;
      }
      await registro.actualizar(s.id, {
        estado: "trabajando",
        enColaRecursos: false,
        motivoCola: null,
      });
      const updated = registro.leer().find((x) => x.id === s.id) || {
        ...s,
        estado: "trabajando",
        enColaRecursos: false,
        motivoCola: null,
      };
      launchWork(updated, next.brief, next.cwd, {
        attachments: next.attachments || [],
        commandId: next.commandId || null,
      });
      if (pq) {
        const job = active.get(s.id);
        Promise.resolve(job?.promesa).finally(() => {
          queuedPromises.delete(s.id);
          pq.resolve();
        });
      }
    }
  }
  // Readers learn "the program is gone" from the registry; this runs after the
  // final state was saved, so the notification must follow the release.
  /** @param {string} id */
  async function liberar(id) {
    const persistentLive = Boolean(conversations?.hasLiveController?.(id));
    if (!persistentLive) {
      liveProcesses.delete(id);
      try {
        await stopSessionScope(id, env);
      } catch {
        const job = active.get(id);
        if (job) job.cleanupFailed = true;
        await registro.actualizar(id, {
          estado: "error",
          error:
            "No se pudo confirmar el cierre del grupo de procesos. Requiere mantenimiento.",
        });
        return; // Keep its slot reserved while descendants may still exist.
      }
    }
    active.get(id)?.detenerVigilante?.();
    active.delete(id);
    if (persistentLive) buildIdleEviction(id);
    if (resourceQueue.length > 0) {
      await serial(() => dispatchResourcesQueue()).catch(() => {});
    }
    registro.notificar?.();
  }
  /**
   * @param {LauncherSession} session
   * @param {string} brief
   * @param {string} cwd
   * @param {TurnOptions} [turnOptions]
   */
  function launchWork(session, brief, cwd, turnOptions = {}) {
    cleanIdleEviction(session.id);
    /** @type {ActiveJob} */
    const job = { hijo: null, cancelada: false, promesa: null, pendientes: 0 };
    active.set(session.id, job);
    job.promesa = Promise.resolve()
      .then(() => mark(session.id, brief))
      .then(() => run(session, brief, cwd, turnOptions))
      .catch(async (error) => {
        diagnose(session, brief, {
          mensaje: error?.message,
          pila: error?.stack,
        });
        if (
          session.structured &&
          conversations?.hasLiveController?.(session.id)
        ) {
          await conversations
            .shutdown(session.id, {
              reason: job.cancelada ? "Turno cancelado" : "Error en turno",
            })
            .catch(() => {});
        }
        if (job.hijo) {
          try {
            signal(job.hijo, "SIGKILL");
          } catch {}
        }
        try {
          await registro.actualizar(session.id, {
            estado: job.cancelada ? "cancelada" : "error",
            interactiva: false,
            ...(session.structured
              ? {
                  conexion: {
                    estado: "cerrada",
                    pid: null,
                    motivo: job.cancelada
                      ? "Turno cancelado"
                      : error instanceof LauncherError
                        ? error.message
                        : "Error en turno",
                  },
                }
              : {}),
            error: session.structured
              ? error instanceof LauncherError
                ? error.message
                : "El proveedor no completó la conversación. Comprueba el ejecutable, su autenticación y la compatibilidad del protocolo en el servidor."
              : "No se pudo ejecutar el motor.",
          });
        } catch {
          diagnose(session, brief, {
            mensaje: "No se pudo persistir el estado final.",
          });
        }
      })
      .finally(async () => {
        await liberar(session.id);
        if (session.structured && !job.cancelada) await drainQueue(session.id);
      });
  }
  const { activeJob, vigilar: watch } = createMonitor(config, state, {
    senalar: signal,
  });
  const { correrRemoto: runRemote } = createRemoteRunner(config, state, {
    activeJob,
    diagnosticar: diagnose,
    margenDiagnostico: diagnosticMargin,
    senalar: signal,
    vigilar: watch,
  });
  const { correr: run } = createLocalRunner(config, state, {
    acpGeminiDirFor,
    activeJob,
    correrRemoto: runRemote,
    diagnosticar: diagnose,
    margenDiagnostico: diagnosticMargin,
    resolveSessionEffectiveProfile,
    sanitizeChildEnv,
    senalar: signal,
    vigilar: watch,
  });
  const { iniciar: start } = createStarter(config, state, {
    lanzarTrabajo: launchWork,
    asegurarCupo: ensureSlot,
    cleanupSessionRuntimeSecrets,
    copiarEntradasProyecto: copyProjectEntries,
    limpiarWorkspaceMiembro: cleanMemberWorkspace,
    writeSessionTokenFile,
  });
  /**
   * Starts the next queued message of an idle structured session. Called when
   * a turn ends and after a message is queued, since either can happen first.
   * @param {string} id
   */
  async function drainQueue(id) {
    if (!conversations || active.has(id) || draining.has(id)) return;
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    if (sesion?.estado !== "terminada" || !sesion.conversacionId) return;
    draining.add(id);
    try {
      const siguiente = await conversations
        .consumeNextQueuedMessage(id)
        .catch(/** @returns {null} */ () => null);
      if (!siguiente) return;
      // A later tick lets the finished turn settle before the next one starts.
      await new Promise((r) => setImmediate(r));
      await proceed(id, siguiente.text, {
        attachments: siguiente.attachments,
        commandId: siguiente.commandId,
      }).catch((error) =>
        conversations
          .markCommandDelivery(
            id,
            siguiente.commandId,
            "entrega_incierta",
            error?.message || "No se pudo iniciar el turno en cola.",
          )
          .catch(() => {}),
      );
    } finally {
      draining.delete(id);
    }
  }
  /**
   * @param {string} id
   * @param {string} brief
   * @param {TurnOptions} [turnOptions]
   */
  function proceed(id, brief, turnOptions = {}) {
    return serial(async () => {
      const session = registro.leer().find((s) => s.id === id && !s.eliminada);
      if (session?.structured) {
        if (active.has(id))
          throw new LauncherError(
            "Espera a que termine el turno o detenlo antes de enviar otro mensaje.",
            409,
          );
        if (!session.directorio || !session.conversacionId)
          throw new LauncherError(
            "No se puede reanudar esta conversación.",
            409,
          );
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await ensureSlot(id);
        const validatedAttachments = validateEngineAttachments(
          session.motor,
          turnOptions.attachments || [],
          session.directorio,
        );
        await registro.actualizar(id, { estado: "trabajando", error: null });
        launchWork(session, brief, session.directorio, {
          attachments: validatedAttachments,
          commandId: turnOptions.commandId || null,
        });
        return registro.leer().find((s) => s.id === id);
      }
      if (session?.harness && !active.has(id)) {
        if (!session.conversacionId || !session.directorio)
          throw new Error("Conversación no disponible");
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await ensureSlot(id);
        await registro.actualizar(id, { estado: "trabajando", error: null });
        launchWork(session, brief, session.directorio);
        return registro.leer().find((s) => s.id === id);
      }
      const native = active.get(id);
      if (native?.nativo && session?.estado === "terminada") {
        const input = native.hijo?.stdin;
        if (!input) throw new Error("Terminal no disponible");
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await registro.actualizar(id, { estado: "trabajando", error: null });
        await mark(id, brief);
        input.write(JSON.stringify({ texto: brief }) + "\n");
        return registro.leer().find((s) => s.id === id);
      }
      if (
        !session?.conversacionId ||
        session.origen === "remote" ||
        !["claude", "agy"].includes(session.motor) ||
        (!session.directorio &&
          !Object.hasOwn(projects, String(session.proyecto)))
      )
        throw new Error("Conversación no disponible");
      if (active.has(id)) throw new Error("Límite de sesiones activas");
      await ensureSlot(id);
      if (typeof brief !== "string" || !brief.trim())
        throw new Error("Encargo vacío");
      await registro.actualizar(id, { estado: "trabajando", error: null });
      launchWork(
        session,
        brief,
        session.directorio || projects[String(session.proyecto)],
      );
      return registro.leer().find((s) => s.id === id);
    });
  }
  const {
    flujo: flow,
    terminal,
    entrada: entry,
  } = createTerminalIo(config, state, {
    marcar: mark,
  });
  const {
    enviarMensaje: sendMessage,
    listarCola: listQueue,
    cancelarCola: cancelQueue,
  } = createConversationQueue(config, state, {
    continuar: proceed,
    drenarCola: drainQueue,
  });
  const {
    encargar: delegate,
    encargarHija: delegateChild,
    esperarHija: waitChild,
  } = createDelegation(config, state, {
    iniciar: start,
    resolveSessionEffectiveProfile,
  });
  const {
    cancelar: cancel,
    eliminar: remove,
    esperar: wait,
  } = createLifecycle(config, state, {
    liberar,
    acpGeminiDirFor,
    cerrarConexion: closeConnection,
    cleanupSessionRuntimeSecrets,
    limpiarEviccionOciosa: cleanIdleEviction,
    limpiarWorkspaceMiembro: cleanMemberWorkspace,
    senalar: signal,
  });
  return {
    flujo: flow,
    terminal,
    entrada: entry,
    eliminar: remove,
    continuar: proceed,
    activos: () => sessionsOccupyingSlot().size,
    conexionesActivas: () => conversations?.liveSessions?.() ?? [],
    /**
     * @param {string} id
     * @param {string} [reason]
     */
    cerrarConexion: (id, reason) => serial(() => closeConnection(id, reason)),
    cerrarTodo: closeAll,
    enviarMensaje: sendMessage,
    listarCola: listQueue,
    cancelarCola: cancelQueue,
    encargar: delegate,
    encargarHija: delegateChild,
    cancelar: cancel,
    esperarHija: waitChild,
    esperar: wait,
  };
}
