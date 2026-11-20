import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agyWindows, claudeWindows, codexWindows } from "./engines.mjs";

/** @import { Dirent } from "node:fs" */
/** @import { AgyQuota, ClaudeUsageSnapshot, CodexUsageSnapshot, UsageWindowId, UsageWindows } from "./engine-types.d.ts" */

/** @typedef {{ usados: number, limite: number }} ContextUsage */
/**
 * @typedef {object} UsageSnapshot
 * @property {UsageWindows} ventanas
 * @property {string | null} actualizado
 * @property {string | null} [plan]
 * @property {ContextUsage} [contexto]
 * @property {string} [contextoActualizado]
 */
/** @typedef {"codex" | "claude" | "agy"} UsageEngine */
/** @typedef {Record<UsageEngine, UsageSnapshot | null> & { en: number }} UsageCache */
/**
 * @typedef {object} StatusLinePayload
 * @property {ClaudeUsageSnapshot} [rate_limits]
 * @property {AgyQuota} [quota]
 * @property {{ id?: string }} [model]
 * @property {{ current_usage?: Record<string, unknown>, context_window_size?: number, used_percentage?: number }} [context_window]
 */
/** @typedef {{ timestamp?: string, payload?: { rate_limits?: CodexUsageSnapshot & { limit_id?: string, plan_type?: string } } }} CodexUsageEvent */

// Only the end of a rollout matters: Codex writes its limits after every turn.
const QUEUE = 512 * 1024;
const MAX_FILES = 6;
const VALIDITY = 30_000;

/**
 * Latest account limits in a rollout; only numbers leave this function.
 * @param {string} text
 * @returns {UsageSnapshot | null}
 */
export function latestCodexUsage(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    /** @type {CodexUsageEvent} */
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue; // The tail can start in the middle of a line.
    }
    const limites = event.payload?.rate_limits;
    if (!limites || (limites.limit_id && limites.limit_id !== "codex"))
      continue;
    const windows = codexWindows(limites);
    if (Object.keys(windows).length)
      return {
        ventanas: windows,
        actualizado: event.timestamp || null,
        plan: typeof limites.plan_type === "string" ? limites.plan_type : null,
      };
  }
  return null;
}

/**
 * A window that already reset is empty, even if no session has said so yet.
 * @param {UsageSnapshot | null} usage
 */
export function current(usage, ahora = Date.now()) {
  if (!usage) return null;
  /** @type {UsageWindows} */
  const windows = {};
  for (const [id, v] of Object.entries(usage.ventanas))
    windows[/** @type {UsageWindowId} */ (id)] =
      v.reinicia && Date.parse(v.reinicia) <= ahora
        ? { usado: 0, reinicia: null, agotada: false }
        : v;
  return { ...usage, ventanas: windows };
}

/**
 * @param {string} dir
 * @param {number} depth
 * @returns {Promise<string[]>}
 */
async function recentFolders(dir, depth) {
  const names = await readdir(dir, { withFileTypes: true }).catch(
    /** @returns {Dirent[]} */ () => [],
  );
  const folders = names
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => e.name)
    .sort()
    .reverse();
  if (depth === 0) return [dir];
  const found = [];
  for (const nombre of folders) {
    found.push(...(await recentFolders(path.join(dir, nombre), depth - 1)));
    if (found.length >= 2) break;
  }
  return found;
}

/** @param {string} file */
async function queue(file) {
  const handler = await open(file, "r");
  try {
    const { size } = await handler.stat();
    const long = Math.min(size, QUEUE);
    const buffer = Buffer.alloc(long);
    await handler.read(buffer, 0, long, size - long);
    return buffer.toString("utf8");
  } finally {
    await handler.close();
  }
}

/**
 * Reads what Codex already recorded: asking its servers would spend nothing, but needs a process.
 * @param {string} sesiones
 */
export async function readCodexUsage(sesiones) {
  // sessions/YYYY/MM/DD/rollout-*.jsonl
  const files = [];
  for (const dir of await recentFolders(sesiones, 3))
    for (const name of await readdir(dir).catch(
      /** @returns {string[]} */ () => [],
    ))
      if (/^rollout-.*\.jsonl$/.test(name)) {
        const complete = path.join(dir, name);
        const info = await stat(complete).catch(
          /** @returns {null} */ () => null,
        );
        if (info?.isFile())
          files.push({ completo: complete, cambio: info.mtimeMs });
      }
  files.sort((a, b) => b.cambio - a.cambio);
  for (const { completo } of files.slice(0, MAX_FILES)) {
    const usage = latestCodexUsage(await queue(completo).catch(() => ""));
    if (usage) return usage;
  }
  return null;
}

// Claude Code and Antigravity only hand their limits to the status line, so a
// small command keeps the numbers next to each CLI's own configuration.
const LINE_FILE = "sb-uso.json";
/** @type {Record<"claude" | "agy", (datos: StatusLinePayload | null) => UsageWindows>} */
const LINE_READERS = {
  claude: (data) => claudeWindows(data?.rate_limits),
  agy: (data) => agyWindows(data?.quota, data?.model?.id),
};
/** @param {StatusLinePayload | null} data */
export function lineContext(data) {
  const window = data?.context_window;
  const usage = window?.current_usage;
  let used =
    usage &&
    [
      "input_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "output_tokens",
    ].reduce((n, k) => n + (Number(usage[k]) || 0), 0);
  const size = window?.context_window_size;
  const percent = window?.used_percentage;
  if (
    !used &&
    size !== undefined &&
    percent !== undefined &&
    Number.isFinite(size) &&
    Number.isFinite(percent)
  )
    used = Math.round((size * percent) / 100);
  return used !== undefined && Number.isFinite(used) && used > 0
    ? { usados: used, limite: 400000 }
    : null;
}
/** @param {unknown} text */
const quotes = (text) => `'${String(text).replace(/'/g, "")}'`;

/** @param {string} home */
export const agyFolder = (home) => path.join(home, ".gemini/antigravity-cli");

/**
 * The status line command for an agent; it only runs locally and spends no quota.
 * @param {string} engine
 * @param {string} folder
 * @param {string} [signature]
 */
export const usageLine = (engine, folder, signature) => ({
  type: "command",
  command: [
    process.execPath,
    fileURLToPath(new URL("./usage-line.mjs", import.meta.url)),
    engine,
    path.join(folder, LINE_FILE),
    signature,
  ]
    .map(quotes)
    .join(" "),
});

/** @param {{ command?: unknown } | null} [linea] */
// Releases before the English rename installed the script as uso-linea.mjs;
// recognising it lets those settings move to the new path.
export const isUsageLine = (linea) =>
  /(?:usage-line|uso-linea)\.mjs/.test(String(linea?.command));

/**
 * @param {string} file
 * @returns {Promise<UsageSnapshot | null>}
 */
export async function readUsageLine(file) {
  /** @type {Partial<UsageSnapshot>} */
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  /** @type {UsageWindows} */
  const windows = {};
  for (const id of /** @type {const} */ (["5h", "semanal"])) {
    const v = data?.ventanas?.[id];
    if (typeof v?.usado === "number" && Number.isFinite(v.usado))
      windows[id] = {
        usado: v.usado,
        reinicia: typeof v.reinicia === "string" ? v.reinicia : null,
        agotada: v.usado >= 100,
      };
  }
  const used = data?.contexto?.usados;
  const context =
    used !== undefined && Number.isFinite(used) && used > 0
      ? { usados: used, limite: 400000 }
      : null;
  return Object.keys(windows).length || context
    ? {
        ventanas: windows,
        ...(context
          ? { contexto: context, contextoActualizado: data.contextoActualizado }
          : {}),
        actualizado:
          typeof data.actualizado === "string" ? data.actualizado : null,
      }
    : null;
}

/**
 * Keeps only the numbers of a status line payload, which also carries paths and
 * the account's email. A window the CLI stopped sending stays: `vigente` empties it.
 * @param {string} engine
 * @param {StatusLinePayload | null} data
 * @param {string} file
 */
export async function saveUsageLine(engine, data, file, ahora = Date.now()) {
  const windows =
    LINE_READERS[/** @type {keyof typeof LINE_READERS} */ (engine)]?.(data);
  const context = lineContext(data);
  if ((!windows || !Object.keys(windows).length) && !context) return false;
  const previous = await readUsageLine(file);
  const temporary = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    temporary,
    JSON.stringify({
      ventanas: { ...previous?.ventanas, ...windows },
      actualizado: Object.keys(windows || {}).length
        ? new Date(ahora).toISOString()
        : previous?.actualizado,
      ...(context
        ? {
            contexto: context,
            contextoActualizado: new Date(ahora).toISOString(),
          }
        : previous?.contexto
          ? {
              contexto: previous.contexto,
              contextoActualizado: previous.contextoActualizado,
            }
          : {}),
    }),
    { mode: 0o600 },
  );
  await rename(temporary, file);
  return true;
}

export function createUsage({ env = process.env, ahora = Date.now } = {}) {
  /** @type {UsageCache | null} */
  let memory = null;
  return async function uso() {
    if (!memory || ahora() - memory.en > VALIDITY) {
      const root =
        env.CODEX_HOME || (env.HOME && path.join(env.HOME, ".codex"));
      memory = {
        en: ahora(),
        codex: root
          ? await readCodexUsage(path.join(root, "sessions")).catch(
              /** @returns {null} */ () => null,
            )
          : null,
        claude: env.AGENTES_CLAUDE_DIR
          ? await readUsageLine(path.join(env.AGENTES_CLAUDE_DIR, LINE_FILE))
          : null,
        agy: env.HOME
          ? await readUsageLine(path.join(agyFolder(env.HOME), LINE_FILE))
          : null,
      };
    }
    /** @type {Partial<Record<UsageEngine, UsageSnapshot>>} */
    const result = {};
    for (const engine of /** @type {const} */ (["codex", "claude", "agy"])) {
      const actual = current(memory[engine], ahora());
      if (actual) result[engine] = actual;
    }
    return result;
  };
}
