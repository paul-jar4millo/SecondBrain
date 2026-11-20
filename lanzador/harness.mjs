import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { opcionesClaude } from "./motores.mjs";

/** @import { TerminalEvent, TerminalSnapshot } from "./types.d.ts" */
/** @import { LauncherSession } from "./session-types.d.ts" */

const { Terminal } = xterm;

/**
 * A repository's own .mcp.json wins over the user's config. SecondBrain's runs
 * the server over `ssh` from the owner's PC, so inside the container it died with
 * CONNECTION_CLOSED. Harnesses always get the local server, whatever the folder.
 * @param {NodeJS.ProcessEnv} [entorno]
 */
export function mcpLocal(entorno = {}) {
  if (!entorno.SB_BRAIN_TOKEN_FILE) return [];
  const env = Object.fromEntries(
    ["SB_BRAIN_TOKEN_FILE", "SB_BRAIN_URL", "SB_AGENTE", "SB_SESSION_ID"]
      .filter((clave) => entorno[clave])
      .map((clave) => [clave, entorno[clave]]),
  );
  return [
    // --mcp-config is variadic: the next flag is what ends its list.
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        secondbrain: {
          type: "stdio",
          command: process.execPath,
          args: [fileURLToPath(new URL("../mcp/index.mjs", import.meta.url))],
          env,
        },
      },
    }),
    "--strict-mcp-config",
  ];
}

/**
 * @param {Pick<LauncherSession, "id" | "motor" | "modelo" | "esfuerzo" | "conversacionId">} sesion
 * @param {string} brief
 * @param {NodeJS.ProcessEnv} entorno
 */
export function comandoHarness(sesion, brief, entorno) {
  const { motor, modelo, esfuerzo, conversacionId } = sesion;
  if (motor === "claude" || motor === "deepseek")
    return {
      bin: "claude",
      args: [
        "--permission-mode",
        "bypassPermissions",
        ...(motor === "claude" ? ["--remote-control=SecondBrain"] : []),
        ...(conversacionId
          ? ["--resume", conversacionId]
          : ["--session-id", sesion.id]),
        ...mcpLocal(entorno),
        ...opcionesClaude(motor, { modelo, esfuerzo }),
        "--",
        brief,
      ],
    };
  if (motor === "codex")
    return {
      bin: "codex",
      args: [
        "--no-alt-screen",
        "--no-daemon",
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'mcp_servers.secondbrain.env_vars=["SB_BRAIN_TOKEN_FILE","SB_BRAIN_URL","SB_AGENTE","SB_SESSION_ID"]',
        "-c",
        "model_auto_compact_token_limit=350000",
        ...(modelo ? ["-m", modelo] : []),
        ...(esfuerzo ? ["-c", `model_reasoning_effort="${esfuerzo}"`] : []),
        ...(conversacionId ? ["resume", conversacionId] : []),
        "--",
        `Contexto SecondBrain: sesión ${sesion.id}.\n\n${brief}`,
      ],
    };
  if (motor === "agy")
    return {
      bin: "agy",
      args: [
        "--dangerously-skip-permissions",
        ...(conversacionId ? ["--conversation", conversacionId] : []),
        ...(modelo ? ["--model", modelo] : []),
      ],
    };
  throw new Error("Motor desconocido");
}

/** The PTY never goes below this size: a phone must not shrink the shared screen. */
export const MIN_COLS = 80;
export const MIN_ROWS = 24;
export const MAX_COLS = 300;
export const MAX_ROWS = 150;

/**
 * Replies to terminal queries (device attributes, cursor position, mode reports)
 * belong to the keyboard direction. When one shows up in the output (an echo) and
 * is replayed into a client, that client answers it again and the program gets
 * phantom input. Best effort: a sequence split between two chunks is left alone.
 */
const RESPUESTAS = new RegExp(
  String.fromCharCode(27) +
    String.raw`\[(?:\?[\d;]*c|>\d+(?:;\d+)+c|\d+;\d+R|\??[\d;]+\$y)`,
  "g",
);
/** @param {string} texto */
export const quitarRespuestas = (texto) => texto.replace(RESPUESTAS, "");

/**
 * Applies the size rule shared by every resize request.
 * @param {unknown} cols
 * @param {unknown} rows
 */
export function tamanoPermitido(cols, rows) {
  if (
    typeof cols !== "number" ||
    typeof rows !== "number" ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows)
  )
    throw new Error("Tamaño inválido");
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, cols)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows)),
  };
}

/**
 * Server-side screen of one harness. The PTY output feeds a headless xterm, so a
 * snapshot is always a clean state (it never cuts an escape sequence) and a late
 * client does not replay raw bytes. `seq` counts the chunks fed; a snapshot is
 * consistent with exactly the chunks up to its `seq`.
 */
export function crearTerminal({
  cols = 120,
  rows = 40,
  scrollback = 3000,
} = {}) {
  const pantalla = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  const serializador = new SerializeAddon();
  pantalla.loadAddon(serializador);
  /** @type {Set<(event: TerminalEvent) => void>} */
  const oyentes = new Set();
  let seq = 0;
  /** @param {TerminalEvent} evento */
  const avisar = (evento) => {
    for (const oyente of oyentes) {
      try {
        oyente(evento);
      } catch {
        /* a broken reader never stops the program */
      }
    }
  };
  const serializar = (lineas = scrollback) =>
    serializador.serialize({ scrollback: lineas });
  return {
    get seq() {
      return seq;
    },
    get cols() {
      return pantalla.cols;
    },
    get rows() {
      return pantalla.rows;
    },
    /** @param {unknown} texto */
    append(texto) {
      const datos = quitarRespuestas(String(texto));
      if (!datos) return;
      seq++;
      pantalla.write(datos);
      avisar({ tipo: "salida", datos, seq });
    },
    /**
     * Resolves once every chunk appended so far has been parsed.
     * @returns {Promise<TerminalSnapshot>}
     */
    snapshot() {
      const hasta = seq;
      return new Promise((resolve) => {
        pantalla.write("", () =>
          resolve({
            datos: serializar(),
            cols: pantalla.cols,
            rows: pantalla.rows,
            seq: hasta,
          }),
        );
      });
    },
    /** Current state without waiting for pending writes (periodic persistence). */
    serializar,
    /**
     * @param {number} nuevasCols
     * @param {number} nuevasFilas
     */
    redimensionar(nuevasCols, nuevasFilas) {
      if (nuevasCols === pantalla.cols && nuevasFilas === pantalla.rows) return;
      pantalla.resize(nuevasCols, nuevasFilas);
      avisar({ tipo: "tamano", cols: nuevasCols, rows: nuevasFilas });
    },
    /** @param {(event: TerminalEvent) => void} fn */
    suscribir(fn) {
      oyentes.add(fn);
      return () => oyentes.delete(fn);
    },
    dispose() {
      oyentes.clear();
      pantalla.dispose();
    },
  };
}

/**
 * Per-reader coalescing: small PTY chunks become one `salida` every `ms`, so a
 * redraw that arrives in pieces costs one network write. `desde` and `seq` bound
 * the chunks inside, letting the client notice a gap.
 * @param {(batch: { datos: string, desde: number, seq: number }) => void} enviar
 */
export function coalescer(enviar, ms = 24) {
  let datos = "";
  let desde = 0;
  let seq = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const vaciar = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!datos) return;
    const lote = { datos, desde, seq };
    datos = "";
    enviar(lote);
  };
  return {
    /**
     * @param {string} texto
     * @param {number} numero
     */
    agregar(texto, numero) {
      if (!datos) desde = numero;
      datos += texto;
      seq = numero;
      if (datos.length > 65536) vaciar();
      else timer ??= setTimeout(vaciar, ms);
    },
    vaciar,
    cancelar() {
      clearTimeout(timer);
      timer = undefined;
      datos = "";
    },
  };
}
