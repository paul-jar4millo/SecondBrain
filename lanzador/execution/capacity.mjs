// Process slots: which sessions hold one, evicting idle controllers to make
// room, and closing every connection on shutdown.
import { ErrorLanzador } from "../errores.mjs";
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
  const { conversations, env, idleControllerMs, maxActivos, registro } = config;
  const {
    activos,
    idleTimers,
    liveProcesses,
    materializedSkillCleanups,
    serial,
    sessionTokenFiles,
  } = state;
  const { acpGeminiDirFor, cleanupSessionRuntimeSecrets } = deps;
  /** @param {string} id */
  function limpiarEviccionOciosa(id) {
    const timer = idleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(id);
    }
  }
  /** @param {string} id */
  function armarEviccionOciosa(id) {
    limpiarEviccionOciosa(id);
    if (!Number.isFinite(idleControllerMs) || idleControllerMs <= 0) return;
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      if (activos.has(id) || !conversations?.hasLiveController?.(id)) return;
      void serial(() =>
        cerrarConexion(id, "Evictada por inactividad", {
          estadoConexion: "evictada",
        }),
      ).catch(() => {});
    }, idleControllerMs);
    timer.unref?.();
    idleTimers.set(id, timer);
  }
  function sesionesOcupandoCupo() {
    const ids = new Set(activos.keys());
    if (conversations?.liveSessions) {
      for (const live of conversations.liveSessions()) {
        ids.add(live.id);
      }
    }
    return ids;
  }
  /** @param {string} id */
  async function cerrarConexion(
    id,
    reason = "Cierre explícito",
    { estadoConexion = "cerrada" } = {},
  ) {
    limpiarEviccionOciosa(id);
    if (activos.has(id)) {
      throw new ErrorLanzador(
        "Detén la sesión antes de cerrar su conexión.",
        409,
      );
    }
    const closed = await conversations?.shutdown?.(id, { reason });
    await stopSessionScope(id, env).catch(() => {});
    liveProcesses.delete(id);
    const exists = registro.leer().some((s) => s.id === id && !s.eliminada);
    if (exists) {
      await registro
        .actualizar(id, {
          conexion: {
            estado: estadoConexion,
            pid: null,
            motivo: reason,
          },
        })
        .catch(() => {});
    }
    registro.notificar?.();
    return closed || { closed: false, id, pid: null, reason };
  }
  /** @param {string[]} [excludeIds] */
  async function evictOneIdle(
    reason = "Evictada por límite de procesos activos",
    excludeIds = [],
  ) {
    if (!conversations?.evictOldestIdle) return null;
    const evicted = await conversations.evictOldestIdle(reason, [
      ...activos.keys(),
      ...excludeIds,
    ]);
    if (!evicted?.closed) return null;
    limpiarEviccionOciosa(evicted.id);
    await stopSessionScope(evicted.id, env).catch(() => {});
    liveProcesses.delete(evicted.id);
    await registro
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
  async function asegurarCupo(sessionId = null) {
    const ocupadas = sesionesOcupandoCupo();
    if (sessionId && ocupadas.has(sessionId)) return;
    while (sesionesOcupandoCupo().size >= maxActivos) {
      const evicted = await evictOneIdle(
        "Evictada por límite de procesos activos",
        sessionId ? [sessionId] : [],
      );
      if (!evicted) throw new Error("Límite de sesiones activas");
    }
  }
  async function cerrarTodo(reason = "Apagado del lanzador") {
    for (const id of [...idleTimers.keys()]) limpiarEviccionOciosa(id);
    const ids = new Set([
      ...sesionesOcupandoCupo(),
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
    limpiarEviccionOciosa,
    armarEviccionOciosa,
    sesionesOcupandoCupo,
    cerrarConexion,
    evictOneIdle,
    asegurarCupo,
    cerrarTodo,
  };
}
