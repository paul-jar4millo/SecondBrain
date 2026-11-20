// Watches a running job: the session time limit and the inactivity timeout.
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { MonitoredChild } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "senalar">} deps
 */
export function createMonitor(config, state, deps) {
  const { cancelarTemporizador, inactividadMs, limiteMs, programar, registro } =
    config;
  const { activos } = state;
  const { senalar } = deps;
  /** @param {string} id */
  function activeJob(id) {
    const job = activos.get(id);
    if (!job) throw new Error("Sesión no activa");
    return job;
  }

  /**
   * @param {LauncherSession} sesion
   * @param {MonitoredChild} hijo
   */
  function vigilar(sesion, hijo) {
    const job = activeJob(sesion.id);
    /** @type {NodeJS.Timeout | undefined} */
    let escalada;
    /** @type {NodeJS.Timeout | undefined} */
    let inactivo;
    const actividad = () => {
      cancelarTemporizador(inactivo);
      if (job.inactiva) {
        job.inactiva = false;
        registro
          .actualizar(sesion.id, { ultimaAccion: "Actividad reanudada." })
          .catch(() => {});
      }
      inactivo = programar(() => {
        if (!activos.has(sesion.id) || job.cancelada) return;
        job.inactiva = true;
        registro
          .actualizar(sesion.id, {
            ultimaAccion: "Sin actividad; puedes cancelar la sesión.",
          })
          .catch(() => {});
      }, inactividadMs);
      inactivo?.unref?.();
    };
    actividad();
    hijo.stdout.on("data", actividad);
    hijo.stderr.on("data", actividad);
    const tope = programar(() => {
      if (job.cancelada || !activos.has(sesion.id)) return;
      job.excedida = true;
      senalar(hijo, "SIGTERM");
      escalada = programar(() => {
        if (activos.get(sesion.id) === job) senalar(hijo, "SIGKILL");
      }, 5000);
      escalada?.unref?.();
    }, limiteMs);
    tope?.unref?.();
    const detener = () => {
      for (const reloj of [tope, inactivo, escalada])
        cancelarTemporizador(reloj);
      hijo.stdout.off("data", actividad);
      hijo.stderr.off("data", actividad);
    };
    job.detenerVigilante = detener;
    return detener;
  }
  return {
    activeJob,
    vigilar,
  };
}
