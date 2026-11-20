// The executor's options with their defaults applied, so every execution
// module receives the same resolved values.
import { engineCommand, deepSeekBalance } from "../engines.mjs";
import { comandoHarness } from "../harness.mjs";
import { spawn } from "node:child_process";

/** @import { ExecutorOptions } from "../types.d.ts" */

const SESSION_MAX_MIN = 240;

/**
 * @param {unknown} value
 * @param {number} predeterminado
 */
function configuredMinutes(value, predeterminado) {
  const minutes = Number(value);
  return (
    (Number.isFinite(minutes) && minutes > 0 ? minutes : predeterminado) * 60000
  );
}

/** @param {ExecutorOptions} options */
export function resolveExecutorOptions({
  registro: registry,
  equipos: teams,
  proyectos: projects,
  espacios: spaces,
  env = process.env,
  comando: command = engineCommand,
  comandoInteractivo: interactiveCommand = comandoHarness,
  maxActivos: maxActive = 6,
  lanzarPty: launchPty = spawn,
  seguimiento: tracking = null,
  conversations = null,
  toolCatalog = null,
  consultarSaldo: queryBalance = () =>
    deepSeekBalance(env.DEEPSEEK_API_KEY ?? null),
  // A silent CLI must not hold a slot forever, including interactive harnesses.
  limiteMs: limitMs = configuredMinutes(env.SB_SESION_MAX_MIN, SESSION_MAX_MIN),
  inactividadMs: inactivityMs = configuredMinutes(
    env.SB_SESION_INACTIVIDAD_MIN,
    15,
  ),
  idleControllerMs = Number(env.SB_CONTROLADOR_OCIOSO_MIN || 0) > 0
    ? configuredMinutes(env.SB_CONTROLADOR_OCIOSO_MIN, 30)
    : 0,
  programar: schedule = setTimeout,
  cancelarTemporizador: cancelTimer = clearTimeout,
  registrar: register = (line) => console.error(line),
}) {
  return {
    registro: registry,
    equipos: teams,
    proyectos: projects,
    espacios: spaces,
    env,
    comando: command,
    comandoInteractivo: interactiveCommand,
    maxActivos: maxActive,
    lanzarPty: launchPty,
    seguimiento: tracking,
    conversations,
    toolCatalog,
    consultarSaldo: queryBalance,
    limiteMs: limitMs,
    inactividadMs: inactivityMs,
    idleControllerMs,
    programar: schedule,
    cancelarTemporizador: cancelTimer,
    registrar: register,
  };
}

/** @typedef {ReturnType<typeof resolveExecutorOptions>} ExecutorConfig */
