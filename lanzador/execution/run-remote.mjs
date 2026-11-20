// Runs a turn in an interactive harness over a pty, for engines without a
// structured protocol, and relays its terminal.
import { entornoDe, entornoEsfuerzo } from "../motores.mjs";
import { comandoRemoto } from "../remote.mjs";
import { sessionCommand } from "../limits.mjs";
import { prepararAgy, prepararClaude } from "../claude-config.mjs";
import { fileURLToPath } from "node:url";
import { crearTerminal } from "../harness.mjs";
import { randomUUID } from "node:crypto";
import { PROVIDER_BY_ENGINE } from "./process-tools.mjs";
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { LiveTerminal } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

// Bound the terminal replay kept in each session's detail file.
const PERSISTIDO = 500;

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./monitor.mjs").createMonitor>, "activeJob" | "vigilar"> &
 *   Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "diagnosticar" | "margenDiagnostico" | "senalar">} deps
 */
export function createRemoteRunner(config, state, deps) {
  const { comandoInteractivo, env, lanzarPty, registro } = config;
  const { terminales } = state;
  const { activeJob, diagnosticar, margenDiagnostico, senalar, vigilar } = deps;
  /**
   * @param {LauncherSession} sesion
   * @param {string} brief
   * @param {string} cwd
   */
  async function correrRemoto(sesion, brief, cwd) {
    /** @type {Record<string, string | undefined>} */
    const childEnv = {
      ...entornoDe(PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor, env),
      ...entornoEsfuerzo(sesion.motor, sesion.esfuerzo),
      SB_SESSION_ID: sesion.id,
      TERM: "xterm-256color",
      ...(sesion.motor === "agy" ? { SB_INITIAL_PROMPT: brief } : {}),
      ...(!sesion.harness && sesion.motor === "agy"
        ? { SB_WAIT_REMOTE: "1" }
        : {}),
      ...(env.SB_HOOK_TOKEN_FILE
        ? { SB_HOOK_TOKEN_FILE: env.SB_HOOK_TOKEN_FILE }
        : {}),
      ...(env.SB_LANZADOR_PORT
        ? { SB_LANZADOR_PORT: env.SB_LANZADOR_PORT }
        : {}),
    };
    const nativeSpec = sesion.harness
      ? comandoInteractivo(sesion, brief, childEnv)
      : comandoRemoto(sesion, brief);
    const spec = sessionCommand(nativeSpec, sesion.id, env);
    if (sesion.harness && ["claude", "deepseek"].includes(sesion.motor))
      await prepararClaude(childEnv.CLAUDE_CONFIG_DIR, cwd, {
        firma:
          sesion.motor === "deepseek" ? "Marina · DeepSeek" : "Ámbar · Claude",
        medir: sesion.motor === "claude",
      }).catch(() => {}); // a first-run dialog is still answerable in the terminal
    if (sesion.motor === "agy")
      await prepararAgy(childEnv.HOME, cwd).catch(() => {});
    const hijo = lanzarPty(
      "python3",
      [
        fileURLToPath(new URL("./terminal.py", import.meta.url)),
        spec.bin,
        ...spec.args,
      ],
      { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const job = activeJob(sesion.id);
    job.hijo = hijo;
    job.nativo = true;
    if (job.cancelada) senalar(hijo, "SIGTERM");
    const terminal = /** @type {LiveTerminal} */ (crearTerminal());
    terminal.generacion = randomUUID();
    if (sesion.terminal) terminal.append(sesion.terminal + "\r\n");
    terminales.set(sesion.id, terminal);
    // Every reader is attached before the first await: output that arrives in
    // between would otherwise reach only the watchdog, and a fast exit would
    // never be seen.
    let pending = "";
    /** @type {Promise<unknown>} */
    let changes = Promise.resolve();
    // Persisting the replay is not news: telling every client each 10 s would
    // make phones refetch the session list for nothing.
    let guardada = -1;
    const checkpoint = setInterval(() => {
      if (terminal.seq === guardada) return;
      guardada = terminal.seq;
      changes = changes.then(() =>
        registro.actualizar(
          sesion.id,
          { terminal: terminal.serializar(PERSISTIDO) },
          { silencioso: true },
        ),
      );
    }, 10000);
    checkpoint.unref();
    hijo.stdout.setEncoding("utf8");
    hijo.stdout.on("data", (chunk) => {
      terminal.append(chunk);
      pending = (pending + chunk).slice(-32000);
      const url =
        /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(pending)?.[0] ||
        /https:\/\/antigravity\.google\.com\/r\/[A-Za-z0-9_-]+(?:\?[^\s\x1b]+)?/.exec(
          pending,
        )?.[0];
      if (url && url !== sesion.remotoUrl) {
        sesion.remotoUrl = url;
        changes = changes.then(() =>
          registro.actualizar(sesion.id, { remotoUrl: url }),
        );
      }
      const providerId = /codex resume ([a-f0-9-]{36})/i.exec(pending)?.[1];
      if (providerId && !sesion.conversacionId) {
        sesion.conversacionId = providerId;
        changes = changes.then(() =>
          registro.actualizar(sesion.id, { conversacionId: providerId }),
        );
      }
    });
    // terminal.py's own failures land here; the PTY's output goes to stdout. Without
    // this trail a crash only showed up as an empty terminal.
    let fallo = "";
    hijo.stderr.setEncoding("utf8");
    hijo.stderr.on("data", (chunk) => {
      fallo = (fallo + chunk.toString()).slice(-margenDiagnostico(brief));
    });
    const cierre = new Promise((resolve, reject) => {
      hijo.once("error", reject);
      hijo.once("close", resolve);
    });
    cierre.catch(() => {});
    const detenerVigilante = vigilar(sesion, hijo);
    try {
      await registro.actualizar(sesion.id, {
        interactiva: true,
        ...(["claude", "deepseek"].includes(sesion.motor)
          ? { conversacionId: sesion.conversacionId || sesion.id }
          : {}),
      });
      const codigo = await cierre;
      if (codigo && !job.cancelada)
        diagnosticar(sesion, brief, { codigo, diagnostico: fallo });
      await changes;
      await registro.actualizar(sesion.id, {
        terminal: (await terminal.snapshot()).datos,
        interactiva: false,
        estado: job.cancelada
          ? "cancelada"
          : job.excedida
            ? "error"
            : codigo === 0
              ? "terminada"
              : "error",
        ...(job.excedida
          ? { error: "La sesión superó el tiempo máximo y se canceló." }
          : codigo && !job.cancelada
            ? { error: "La sesión interactiva terminó con error." }
            : {}),
      });
    } catch (error) {
      diagnosticar(sesion, brief, {
        mensaje: error?.message,
        pila: error?.stack,
      });
      await registro.actualizar(sesion.id, {
        interactiva: false,
        estado: "error",
        error: "No se pudo abrir la sesión interactiva.",
      });
    } finally {
      clearInterval(checkpoint);
      detenerVigilante();
    }
  }
  return {
    correrRemoto,
  };
}
