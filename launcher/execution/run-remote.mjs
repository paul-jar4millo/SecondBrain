// Runs a turn in an interactive harness over a pty, for engines without a
// structured protocol, and relays its terminal.
import { environmentOf, effortEnvironment } from "../engines.mjs";
import { remoteCommand } from "../remote.mjs";
import { sessionCommand } from "../limits.mjs";
import { prepareAgy, prepareClaude } from "../claude-config.mjs";
import { fileURLToPath } from "node:url";
import { createTerminal } from "../harness.mjs";
import { randomUUID } from "node:crypto";
import { PROVIDER_BY_ENGINE } from "./process-tools.mjs";
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { LiveTerminal } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

// Bound the terminal replay kept in each session's detail file.
const PERSISTED = 500;

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./monitor.mjs").createMonitor>, "activeJob" | "vigilar"> &
 *   Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "diagnosticar" | "margenDiagnostico" | "senalar">} deps
 */
export function createRemoteRunner(config, state, deps) {
  const {
    comandoInteractivo: interactiveCommand,
    env,
    lanzarPty: launchPty,
    registro: registry,
  } = config;
  const { terminales: terminals } = state;
  const {
    activeJob,
    diagnosticar: diagnose,
    margenDiagnostico: diagnosticMargin,
    senalar: signal,
    vigilar: watch,
  } = deps;
  /**
   * @param {LauncherSession} sesion
   * @param {string} brief
   * @param {string} cwd
   */
  async function runRemote(sesion, brief, cwd) {
    /** @type {Record<string, string | undefined>} */
    const childEnv = {
      ...environmentOf(PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor, env),
      ...effortEnvironment(sesion.motor, sesion.esfuerzo),
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
      ? interactiveCommand(sesion, brief, childEnv)
      : remoteCommand(sesion, brief);
    const spec = sessionCommand(nativeSpec, sesion.id, env);
    if (sesion.harness && ["claude", "deepseek"].includes(sesion.motor))
      await prepareClaude(childEnv.CLAUDE_CONFIG_DIR, cwd, {
        firma:
          sesion.motor === "deepseek" ? "Marina · DeepSeek" : "Ámbar · Claude",
        medir: sesion.motor === "claude",
      }).catch(() => {}); // a first-run dialog is still answerable in the terminal
    if (sesion.motor === "agy")
      await prepareAgy(childEnv.HOME, cwd).catch(() => {});
    const child = launchPty(
      "python3",
      [
        fileURLToPath(new URL("../terminal.py", import.meta.url)),
        spec.bin,
        ...spec.args,
      ],
      { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const job = activeJob(sesion.id);
    job.hijo = child;
    job.nativo = true;
    if (job.cancelada) signal(child, "SIGTERM");
    const terminal = /** @type {LiveTerminal} */ (createTerminal());
    terminal.generacion = randomUUID();
    if (sesion.terminal) terminal.append(sesion.terminal + "\r\n");
    terminals.set(sesion.id, terminal);
    // Every reader is attached before the first await: output that arrives in
    // between would otherwise reach only the watchdog, and a fast exit would
    // never be seen.
    let pending = "";
    /** @type {Promise<unknown>} */
    let changes = Promise.resolve();
    // Persisting the replay is not news: telling every client each 10 s would
    // make phones refetch the session list for nothing.
    let saved = -1;
    const checkpoint = setInterval(() => {
      if (terminal.seq === saved) return;
      saved = terminal.seq;
      changes = changes.then(() =>
        registry.actualizar(
          sesion.id,
          { terminal: terminal.serializar(PERSISTED) },
          { silencioso: true },
        ),
      );
    }, 10000);
    checkpoint.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
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
          registry.actualizar(sesion.id, { remotoUrl: url }),
        );
      }
      const providerId = /codex resume ([a-f0-9-]{36})/i.exec(pending)?.[1];
      if (providerId && !sesion.conversacionId) {
        sesion.conversacionId = providerId;
        changes = changes.then(() =>
          registry.actualizar(sesion.id, { conversacionId: providerId }),
        );
      }
    });
    // terminal.py's own failures land here; the PTY's output goes to stdout. Without
    // this trail a crash only showed up as an empty terminal.
    let failure = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      failure = (failure + chunk.toString()).slice(-diagnosticMargin(brief));
    });
    const cierre = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    cierre.catch(() => {});
    const stopWatcher = watch(sesion, child);
    try {
      await registry.actualizar(sesion.id, {
        interactiva: true,
        ...(["claude", "deepseek"].includes(sesion.motor)
          ? { conversacionId: sesion.conversacionId || sesion.id }
          : {}),
      });
      const codigo = await cierre;
      if (codigo && !job.cancelada)
        diagnose(sesion, brief, { codigo, diagnostico: failure });
      await changes;
      await registry.actualizar(sesion.id, {
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
      diagnose(sesion, brief, {
        mensaje: error?.message,
        pila: error?.stack,
      });
      await registry.actualizar(sesion.id, {
        interactiva: false,
        estado: "error",
        error: "No se pudo abrir la sesión interactiva.",
      });
    } finally {
      clearInterval(checkpoint);
      stopWatcher();
    }
  }
  return {
    correrRemoto: runRemote,
  };
}
