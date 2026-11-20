// Ending a session: cancel its turn, delete it with its workspace, or wait
// for it to finish.
import { stopSessionScope } from "../limits.mjs";
import { rm } from "node:fs/promises";
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./capacity.mjs").createCapacity>, "cerrarConexion" | "limpiarEviccionOciosa"> &
 *   Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "acpGeminiDirFor" | "limpiarWorkspaceMiembro" | "senalar"> &
 *   Pick<ReturnType<typeof import("./secrets.mjs").createSessionSecrets>, "cleanupSessionRuntimeSecrets"> &
 *   { liberar: (id: string) => Promise<void> }} deps
 */
export function createLifecycle(config, state, deps) {
  const {
    conversations,
    env,
    proyectos: projects,
    registro: registry,
    seguimiento: tracking,
  } = config;
  const {
    activos: active,
    liveProcesses,
    queuedPromises,
    resourceQueue,
    serial,
    terminales: terminals,
  } = state;
  const {
    acpGeminiDirFor,
    cerrarConexion: closeConnection,
    cleanupSessionRuntimeSecrets,
    limpiarEviccionOciosa: cleanIdleEviction,
    liberar: release,
    limpiarWorkspaceMiembro: cleanMemberWorkspace,
    senalar: signal,
  } = deps;
  /** @param {string} id */
  function eliminar(id) {
    return serial(async () => {
      if (active.has(id))
        throw new Error("Detén la sesión antes de eliminarla");
      const previous = registry.leer().find((s) => s.id === id);
      if (previous?.structured) {
        cleanIdleEviction(id);
        await conversations?.remove(id);
        await stopSessionScope(id, env).catch(() => {});
        liveProcesses.delete(id);
        await rm(acpGeminiDirFor(id), { recursive: true, force: true }).catch(
          () => {},
        );
      }
      await cleanupSessionRuntimeSecrets(id);
      const result = await registry.eliminar(id);
      terminals.delete(id);
      await cleanMemberWorkspace(previous);
      if (tracking && previous)
        await tracking
          .borrar(
            id,
            previous.directorio || projects[String(previous.proyecto)],
          )
          .catch(() => {});
      return result;
    });
  }
  /** @param {string} id */
  async function cancel(
    id,
    { shutdown = false, reason = "Cierre explícito" } = {},
  ) {
    const queuedIndex = resourceQueue.findIndex((item) => item.sesionId === id);
    if (queuedIndex !== -1) {
      resourceQueue.splice(queuedIndex, 1);
      await registry.actualizar(id, {
        estado: "cancelada",
        enColaRecursos: false,
        motivoCola: null,
      });
      const pq = queuedPromises.get(id);
      if (pq) {
        queuedPromises.delete(id);
        pq.resolve();
      }
      return;
    }
    const session = registry.leer().find((s) => s.id === id && !s.eliminada);
    const job = active.get(id);
    if (!job) {
      if (session?.structured && conversations?.hasLiveController?.(id)) {
        return closeConnection(id, reason);
      }
      throw new Error("Sesión no activa");
    }
    job.cancelada = true;
    if (job.cleanupFailed) {
      await release(id);
      return;
    }
    if (
      session?.structured &&
      conversations?.hasLiveController?.(id) &&
      !shutdown
    ) {
      conversations.abort(id);
      return;
    }
    conversations?.abort(id);
    if (session?.structured && shutdown) {
      await conversations?.shutdown?.(id, { reason });
    }
    if (job.hijo) {
      signal(job.hijo, "SIGTERM");
      const clock = setTimeout(() => {
        if (active.has(id) && job.hijo) signal(job.hijo, "SIGKILL");
      }, 5000);
      clock.unref();
    }
  }
  /** @param {string} id */
  function wait(id) {
    return (
      active.get(id)?.promesa ||
      queuedPromises.get(id)?.promise ||
      Promise.resolve()
    );
  }
  return {
    cancelar: cancel,
    eliminar,
    esperar: wait,
  };
}
