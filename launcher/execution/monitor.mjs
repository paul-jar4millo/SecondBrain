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
  const {
    cancelarTemporizador: cancelTimer,
    inactividadMs: inactivityMs,
    limiteMs: limitMs,
    programar: schedule,
    registro: registry,
  } = config;
  const { activos: active } = state;
  const { senalar: signal } = deps;
  /** @param {string} id */
  function activeJob(id) {
    const job = active.get(id);
    if (!job) throw new Error("Sesión no activa");
    return job;
  }

  /**
   * @param {LauncherSession} session
   * @param {MonitoredChild} child
   */
  function watch(session, child) {
    const job = activeJob(session.id);
    /** @type {NodeJS.Timeout | undefined} */
    let scaled;
    /** @type {NodeJS.Timeout | undefined} */
    let idle;
    const activity = () => {
      cancelTimer(idle);
      if (job.inactiva) {
        job.inactiva = false;
        registry
          .actualizar(session.id, { ultimaAccion: "Actividad reanudada." })
          .catch(() => {});
      }
      idle = schedule(() => {
        if (!active.has(session.id) || job.cancelada) return;
        job.inactiva = true;
        registry
          .actualizar(session.id, {
            ultimaAccion: "Sin actividad; puedes cancelar la sesión.",
          })
          .catch(() => {});
      }, inactivityMs);
      idle?.unref?.();
    };
    activity();
    child.stdout.on("data", activity);
    child.stderr.on("data", activity);
    const cap = schedule(() => {
      if (job.cancelada || !active.has(session.id)) return;
      job.excedida = true;
      signal(child, "SIGTERM");
      scaled = schedule(() => {
        if (active.get(session.id) === job) signal(child, "SIGKILL");
      }, 5000);
      scaled?.unref?.();
    }, limitMs);
    cap?.unref?.();
    const stop = () => {
      for (const clock of [cap, idle, scaled]) cancelTimer(clock);
      child.stdout.off("data", activity);
      child.stderr.off("data", activity);
    };
    job.detenerVigilante = stop;
    return stop;
  }
  return {
    activeJob,
    vigilar: watch,
  };
}
