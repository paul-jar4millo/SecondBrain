// The executor's options with their defaults applied, so every execution
// module receives the same resolved values.
import { engineCommand, deepSeekBalance } from "../engines.mjs";
import { comandoHarness } from "../harness.mjs";
import { spawn } from "node:child_process";

/** @import { ExecutorOptions } from "../types.d.ts" */

const SESION_MAX_MIN = 240;

/**
 * @param {unknown} valor
 * @param {number} predeterminado
 */
function minutosConfigurados(valor, predeterminado) {
  const minutos = Number(valor);
  return (
    (Number.isFinite(minutos) && minutos > 0 ? minutos : predeterminado) * 60000
  );
}

/** @param {ExecutorOptions} options */
export function resolveExecutorOptions({
  registro,
  equipos,
  proyectos,
  espacios,
  env = process.env,
  comando = engineCommand,
  comandoInteractivo = comandoHarness,
  maxActivos = 6,
  lanzarPty = spawn,
  seguimiento = null,
  conversations = null,
  toolCatalog = null,
  consultarSaldo = () => deepSeekBalance(env.DEEPSEEK_API_KEY ?? null),
  // A silent CLI must not hold a slot forever, including interactive harnesses.
  limiteMs = minutosConfigurados(env.SB_SESION_MAX_MIN, SESION_MAX_MIN),
  inactividadMs = minutosConfigurados(env.SB_SESION_INACTIVIDAD_MIN, 15),
  idleControllerMs = Number(env.SB_CONTROLADOR_OCIOSO_MIN || 0) > 0
    ? minutosConfigurados(env.SB_CONTROLADOR_OCIOSO_MIN, 30)
    : 0,
  programar = setTimeout,
  cancelarTemporizador = clearTimeout,
  registrar = (linea) => console.error(linea),
}) {
  return {
    registro,
    equipos,
    proyectos,
    espacios,
    env,
    comando,
    comandoInteractivo,
    maxActivos,
    lanzarPty,
    seguimiento,
    conversations,
    toolCatalog,
    consultarSaldo,
    limiteMs,
    inactividadMs,
    idleControllerMs,
    programar,
    cancelarTemporizador,
    registrar,
  };
}

/** @typedef {ReturnType<typeof resolveExecutorOptions>} ExecutorConfig */
