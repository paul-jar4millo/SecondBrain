import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { claudeOptions } from "./engines.mjs";

/** @import { TerminalEvent, TerminalSnapshot } from "./types.d.ts" */
/** @import { LauncherSession } from "./session-types.d.ts" */

const { Terminal } = xterm;

/**
 * A repository's own .mcp.json wins over the user's config. SecondBrain's runs
 * the server over `ssh` from the owner's PC, so inside the container it died with
 * CONNECTION_CLOSED. Harnesses always get the local server, whatever the folder.
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function mcpLocal(environment = {}) {
  if (!environment.SB_BRAIN_TOKEN_FILE) return [];
  const env = Object.fromEntries(
    ["SB_BRAIN_TOKEN_FILE", "SB_BRAIN_URL", "SB_AGENTE", "SB_SESSION_ID"]
      .filter((key) => environment[key])
      .map((key) => [key, environment[key]]),
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
 * @param {NodeJS.ProcessEnv} environment
 */
export function comandoHarness(sesion, brief, environment) {
  const {
    motor: engine,
    modelo,
    esfuerzo: effort,
    conversacionId: conversationId,
  } = sesion;
  if (engine === "claude" || engine === "deepseek")
    return {
      bin: "claude",
      args: [
        "--permission-mode",
        "bypassPermissions",
        ...(engine === "claude" ? ["--remote-control=SecondBrain"] : []),
        ...(conversationId
          ? ["--resume", conversationId]
          : ["--session-id", sesion.id]),
        ...mcpLocal(environment),
        ...claudeOptions(engine, { modelo, esfuerzo: effort }),
        "--",
        brief,
      ],
    };
  if (engine === "codex")
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
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        ...(conversationId ? ["resume", conversationId] : []),
        "--",
        `Contexto SecondBrain: sesión ${sesion.id}.\n\n${brief}`,
      ],
    };
  if (engine === "agy")
    return {
      bin: "agy",
      args: [
        "--dangerously-skip-permissions",
        ...(conversationId ? ["--conversation", conversationId] : []),
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
const RESPONSES = new RegExp(
  String.fromCharCode(27) +
    String.raw`\[(?:\?[\d;]*c|>\d+(?:;\d+)+c|\d+;\d+R|\??[\d;]+\$y)`,
  "g",
);
/** @param {string} text */
export const removeResponses = (text) => text.replace(RESPONSES, "");

/**
 * Applies the size rule shared by every resize request.
 * @param {unknown} cols
 * @param {unknown} rows
 */
export function allowedSize(cols, rows) {
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
export function createTerminal({
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
  const serializer = new SerializeAddon();
  pantalla.loadAddon(serializer);
  /** @type {Set<(event: TerminalEvent) => void>} */
  const listeners = new Set();
  let seq = 0;
  /** @param {TerminalEvent} event */
  const notify = (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a broken reader never stops the program */
      }
    }
  };
  const serializar = (lines = scrollback) =>
    serializer.serialize({ scrollback: lines });
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
    /** @param {unknown} text */
    append(text) {
      const data = removeResponses(String(text));
      if (!data) return;
      seq++;
      pantalla.write(data);
      notify({ tipo: "salida", datos: data, seq });
    },
    /**
     * Resolves once every chunk appended so far has been parsed.
     * @returns {Promise<TerminalSnapshot>}
     */
    snapshot() {
      const until = seq;
      return new Promise((resolve) => {
        pantalla.write("", () =>
          resolve({
            datos: serializar(),
            cols: pantalla.cols,
            rows: pantalla.rows,
            seq: until,
          }),
        );
      });
    },
    /** Current state without waiting for pending writes (periodic persistence). */
    serializar,
    /**
     * @param {number} newCols
     * @param {number} newRows
     */
    redimensionar(newCols, newRows) {
      if (newCols === pantalla.cols && newRows === pantalla.rows) return;
      pantalla.resize(newCols, newRows);
      notify({ tipo: "tamano", cols: newCols, rows: newRows });
    },
    /** @param {(event: TerminalEvent) => void} fn */
    suscribir(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
      pantalla.dispose();
    },
  };
}

/**
 * Per-reader coalescing: small PTY chunks become one `salida` every `ms`, so a
 * redraw that arrives in pieces costs one network write. `desde` and `seq` bound
 * the chunks inside, letting the client notice a gap.
 * @param {(batch: { datos: string, desde: number, seq: number }) => void} send
 */
export function coalesce(send, ms = 24) {
  let data = "";
  let from = 0;
  let seq = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!data) return;
    const batch = { datos: data, desde: from, seq };
    data = "";
    send(batch);
  };
  return {
    /**
     * @param {string} text
     * @param {number} numero
     */
    agregar(text, numero) {
      if (!data) from = numero;
      data += text;
      seq = numero;
      if (data.length > 65536) flush();
      else timer ??= setTimeout(flush, ms);
    },
    vaciar: flush,
    cancelar() {
      clearTimeout(timer);
      timer = undefined;
      data = "";
    },
  };
}
