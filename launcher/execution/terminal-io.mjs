// The live terminal of a session: its event stream, the snapshot for a new
// viewer and keyboard input, including the controller's resize rule.
import { allowedSize } from "../harness.mjs";
/** @import { TerminalEvent, TerminalInput } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "marcar">} deps
 */
export function createTerminalIo(config, state, deps) {
  const { registro: registry, seguimiento: tracking } = config;
  const { activos: active, terminales: terminals } = state;
  const { marcar: mark } = deps;
  /**
   * Source of a harness screen for readers: a live terminal, or the screen
   * saved when the program last exited. `generacion` changes when the
   * program is started again, so readers know to ask for a new snapshot.
   * @param {string} id
   */
  function flow(id) {
    const session = registry.leer().find((s) => s.id === id);
    if (!session?.harness || session.eliminada)
      throw new Error("Terminal no disponible");
    const terminal = terminals.get(id);
    if (terminal)
      return {
        generacion: terminal.generacion,
        activa: () => active.has(id),
        snapshot: () => terminal.snapshot(),
        /** @param {(event: TerminalEvent) => void} fn */
        suscribir: (fn) => terminal.suscribir(fn),
      };
    return {
      generacion: "persistida",
      activa: () => false,
      snapshot: async () => ({
        datos: session.terminal || "",
        cols: 120,
        rows: 40,
        seq: 0,
      }),
      suscribir: () => () => {},
    };
  }
  /** @param {string} id */
  async function terminal(id) {
    const source = flow(id);
    return {
      ...(await source.snapshot()),
      activa: source.activa(),
      generacion: source.generacion,
    };
  }
  /**
   * @param {string} id
   * @param {TerminalInput} options
   */
  function entry(
    id,
    { raw, texto: text, cols, rows, controlador: controller, interrumpir },
  ) {
    const job = active.get(id);
    const session = registry.leer().find((s) => s.id === id);
    const input = job?.hijo?.stdin;
    if (!job?.nativo || !session?.harness || !input?.writable)
      throw new Error("Terminal no disponible");
    /** @param {unknown} value */
    const escribir = (value) => input.write(JSON.stringify(value) + "\n");
    const size = cols !== undefined || rows !== undefined;
    if (
      [
        raw !== undefined,
        text !== undefined,
        size,
        interrumpir === true,
      ].filter(Boolean).length !== 1
    )
      throw new Error("Entrada inválida");
    // Every write waits behind a pending checkpoint, so keys never overtake
    // it; with nothing pending a write goes out at once, as it always did.
    /** @param {() => unknown} fn */
    const queued = (fn, { espera: wait = false } = {}) => {
      if (!wait && !job.pendientes) return fn();
      job.pendientes = (job.pendientes ?? 0) + 1;
      job.cola = (job.cola ?? Promise.resolve())
        .then(fn)
        .catch(() => {
          /* the program exited while the checkpoint was taken */
        })
        .finally(() => job.pendientes--);
    };
    /** @param {string} message */
    const beforeTurn = (message) => {
      job.ultimoTurno = Date.now();
      return mark(id, message);
    };
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.length > 16000)
        throw new Error("Entrada inválida");
      // Enter typed in the Terminal tab while the agent waits starts a turn
      // too. A paste may carry newlines; only a bare Enter submits.
      const loose = raw.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, "");
      // What was typed, as a label for the turn: escapes dropped, Backspace applied.
      let tecleado = job.tecleado ?? "";
      for (const c of loose.replace(/\x1b(\[[0-?]*[ -/]*[@-~]|O.|.)/g, ""))
        if (c === "\x7f" || c === "\b") tecleado = tecleado.slice(0, -1);
        else if (c === "\r" || /\P{C}/u.test(c)) tecleado += c;
      tecleado = tecleado.slice(-200);
      const enter = loose.includes("\r");
      job.tecleado = enter ? "" : tecleado;
      const turno =
        enter &&
        tracking &&
        session.estado !== "trabajando" &&
        Date.now() - (job.ultimoTurno ?? 0) > 5000;
      if (turno) {
        const mensaje =
          tecleado.split("\r")[0].trim() || "Turno desde la terminal";
        queued(
          async () => {
            await beforeTurn(mensaje);
            escribir({ raw });
          },
          { espera: true },
        );
      } else queued(() => escribir({ raw }));
    } else if (text !== undefined) {
      if (typeof text !== "string" || !text.trim() || text.length > 60000)
        throw new Error("Entrada inválida");
      // The checkpoint must exist before the agent can touch a file.
      if (tracking)
        queued(
          async () => {
            await beforeTurn(text);
            escribir({ texto: text });
          },
          { espera: true },
        );
      else queued(() => escribir({ texto: text }));
      // A finished turn on a live program starts another one.
      if (session.estado === "terminada")
        registry
          .actualizar(id, { estado: "trabajando", error: null })
          .catch(() => {});
    } else if (interrumpir === true) {
      // Codex reads Esc as "back"; its interrupt is Ctrl+C. The others use Esc.
      escribir({ raw: session.motor === "codex" ? "\u0003" : "\u001b" });
    } else {
      const measure = allowedSize(cols, rows);
      // Phones and secondary windows never decide the screen everybody shares.
      if (controller !== true) return { ok: true, redimensionada: false };
      escribir(measure);
      terminals.get(id)?.redimensionar(measure.cols, measure.rows);
      return { ok: true, redimensionada: true, ...measure };
    }
    return { ok: true };
  }
  return {
    flujo: flow,
    terminal,
    entrada: entry,
  };
}
