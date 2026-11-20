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
  const { conversations, env, proyectos, registro, seguimiento } = config;
  const {
    activos,
    liveProcesses,
    queuedPromises,
    resourceQueue,
    serial,
    terminales,
  } = state;
  const {
    acpGeminiDirFor,
    cerrarConexion,
    cleanupSessionRuntimeSecrets,
    limpiarEviccionOciosa,
    liberar,
    limpiarWorkspaceMiembro,
    senalar,
  } = deps;
  /** @param {string} id */
  function eliminar(id) {
    return serial(async () => {
      if (activos.has(id))
        throw new Error("Detén la sesión antes de eliminarla");
      const previa = registro.leer().find((s) => s.id === id);
      if (previa?.structured) {
        limpiarEviccionOciosa(id);
        await conversations?.remove(id);
        await stopSessionScope(id, env).catch(() => {});
        liveProcesses.delete(id);
        await rm(acpGeminiDirFor(id), { recursive: true, force: true }).catch(
          () => {},
        );
      }
      await cleanupSessionRuntimeSecrets(id);
      const resultado = await registro.eliminar(id);
      terminales.delete(id);
      await limpiarWorkspaceMiembro(previa);
      if (seguimiento && previa)
        await seguimiento
          .borrar(id, previa.directorio || proyectos[String(previa.proyecto)])
          .catch(() => {});
      return resultado;
    });
  }
  /** @param {string} id */
  async function cancelar(
    id,
    { shutdown = false, reason = "Cierre explícito" } = {},
  ) {
    const queuedIndex = resourceQueue.findIndex((item) => item.sesionId === id);
    if (queuedIndex !== -1) {
      resourceQueue.splice(queuedIndex, 1);
      await registro.actualizar(id, {
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
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    const job = activos.get(id);
    if (!job) {
      if (sesion?.structured && conversations?.hasLiveController?.(id)) {
        return cerrarConexion(id, reason);
      }
      throw new Error("Sesión no activa");
    }
    job.cancelada = true;
    if (job.cleanupFailed) {
      await liberar(id);
      return;
    }
    if (
      sesion?.structured &&
      conversations?.hasLiveController?.(id) &&
      !shutdown
    ) {
      conversations.abort(id);
      return;
    }
    conversations?.abort(id);
    if (sesion?.structured && shutdown) {
      await conversations?.shutdown?.(id, { reason });
    }
    if (job.hijo) {
      senalar(job.hijo, "SIGTERM");
      const reloj = setTimeout(() => {
        if (activos.has(id) && job.hijo) senalar(job.hijo, "SIGKILL");
      }, 5000);
      reloj.unref();
    }
  }
  /** @param {string} id */
  function esperar(id) {
    return (
      activos.get(id)?.promesa ||
      queuedPromises.get(id)?.promise ||
      Promise.resolve()
    );
  }
  return {
    cancelar,
    eliminar,
    esperar,
  };
}
