// Process slots: which sessions hold one, evicting idle controllers to make
// room, and closing every connection on shutdown.
import { LauncherError } from "../errors.mjs";
import { stopSessionScope } from "../limits.mjs";
import { rm } from "node:fs/promises";
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "acpGeminiDirFor"> &
 *   Pick<ReturnType<typeof import("./secrets.mjs").createSessionSecrets>, "cleanupSessionRuntimeSecrets">} deps
 */
export function createCapacity(config, state, deps) {
  const {
    conversations,
    env,
    idleControllerMs,
    maxActivos: maxActive,
    registro: registry,
  } = config;
  const {
    activos: active,
    idleTimers,
    liveProcesses,
    materializedSkillCleanups,
    serial,
    sessionTokenFiles,
  } = state;
  const { acpGeminiDirFor, cleanupSessionRuntimeSecrets } = deps;
  /** @param {string} id */
  function cleanIdleEviction(id) {
    const timer = idleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(id);
    }
  }
  /** @param {string} id */
  function buildIdleEviction(id) {
    cleanIdleEviction(id);
    if (!Number.isFinite(idleControllerMs) || idleControllerMs <= 0) return;
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      if (active.has(id) || !conversations?.hasLiveController?.(id)) return;
      void serial(() =>
        closeConnection(id, "Evictada por inactividad", {
          estadoConexion: "evictada",
        }),
      ).catch(() => {});
    }, idleControllerMs);
    timer.unref?.();
    idleTimers.set(id, timer);
  }
  function sessionsOccupyingSlot() {
    const ids = new Set(active.keys());
    if (conversations?.liveSessions) {
      for (const live of conversations.liveSessions()) {
        ids.add(live.id);
      }
    }
    return ids;
  }
  /** @param {string} id */
  async function closeConnection(
    id,
    reason = "Cierre explícito",
    { estadoConexion: connectionState = "cerrada" } = {},
  ) {
    cleanIdleEviction(id);
    if (active.has(id)) {
      throw new LauncherError(
        "Detén la sesión antes de cerrar su conexión.",
        409,
      );
    }
    const closed = await conversations?.shutdown?.(id, { reason });
    await stopSessionScope(id, env).catch(() => {});
    liveProcesses.delete(id);
    const exists = registry.leer().some((s) => s.id === id && !s.eliminada);
    if (exists) {
      await registry
        .actualizar(id, {
          conexion: {
            estado: connectionState,
            pid: null,
            motivo: reason,
          },
        })
        .catch(() => {});
    }
    registry.notificar?.();
    return closed || { closed: false, id, pid: null, reason };
  }
  /** @param {string[]} [excludeIds] */
  async function evictOneIdle(
    reason = "Evictada por límite de procesos activos",
    excludeIds = [],
  ) {
    if (!conversations?.evictOldestIdle) return null;
    const evicted = await conversations.evictOldestIdle(reason, [
      ...active.keys(),
      ...excludeIds,
    ]);
    if (!evicted?.closed) return null;
    cleanIdleEviction(evicted.id);
    await stopSessionScope(evicted.id, env).catch(() => {});
    liveProcesses.delete(evicted.id);
    await registry
      .actualizar(evicted.id, {
        conexion: {
          estado: "evictada",
          pid: null,
          motivo: evicted.reason || reason,
        },
      })
      .catch(() => {});
    return evicted;
  }
  /** @param {string | null} [sessionId] */
  async function ensureSlot(sessionId = null) {
    const busy = sessionsOccupyingSlot();
    if (sessionId && busy.has(sessionId)) return;
    while (sessionsOccupyingSlot().size >= maxActive) {
      const evicted = await evictOneIdle(
        "Evictada por límite de procesos activos",
        sessionId ? [sessionId] : [],
      );
      if (!evicted) throw new Error("Límite de sesiones activas");
    }
  }
  async function closeAll(reason = "Apagado del lanzador") {
    for (const id of [...idleTimers.keys()]) cleanIdleEviction(id);
    const ids = new Set([
      ...sessionsOccupyingSlot(),
      ...sessionTokenFiles.keys(),
      ...materializedSkillCleanups.keys(),
    ]);
    await conversations?.shutdownAll?.(reason);
    await Promise.allSettled(
      [...ids].map(async (id) => {
        await stopSessionScope(id, env).catch(() => {});
        liveProcesses.delete(id);
        await rm(acpGeminiDirFor(id), { recursive: true, force: true }).catch(
          () => {},
        );
        await cleanupSessionRuntimeSecrets(id);
      }),
    );
  }
  return {
    limpiarEviccionOciosa: cleanIdleEviction,
    armarEviccionOciosa: buildIdleEviction,
    sesionesOcupandoCupo: sessionsOccupyingSlot,
    cerrarConexion: closeConnection,
    evictOneIdle,
    asegurarCupo: ensureSlot,
    cerrarTodo: closeAll,
  };
}
