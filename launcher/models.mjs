import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  environmentOf,
  DEEPSEEK_MODEL,
  DEEPSEEK_THINKING,
} from "./engines.mjs";

/** @import { LauncherEngine } from "./session-types.d.ts" */
/** @typedef {{ id: string, nombre: string, esfuerzo?: string, esfuerzos?: string[] }} LauncherModel */
/** @typedef {Record<LauncherEngine, LauncherModel[]>} ModelCatalog */
/**
 * @typedef {object} CodexModel
 * @property {string} slug
 * @property {string} visibility
 * @property {string} [display_name]
 * @property {string} [default_reasoning_level]
 * @property {{ effort: string }[]} [supported_reasoning_levels]
 */

// What each CLI offers on this server, so a session can run on a chosen model.
// An empty list only means «the program's default»; it never blocks a session.
// Effort levels accepted by `claude --effort`: the current Opus, Sonnet and Haiku
// all take the five levels.
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE = [
  { id: "opus", nombre: "Opus", esfuerzos: CLAUDE_EFFORTS },
  { id: "sonnet", nombre: "Sonnet", esfuerzos: CLAUDE_EFFORTS },
  { id: "haiku", nombre: "Haiku", esfuerzos: CLAUDE_EFFORTS },
];
// Marina has a single model; its effort becomes a thinking budget.
const DEEPSEEK = [
  {
    id: DEEPSEEK_MODEL,
    nombre: "DeepSeek Flash",
    esfuerzos: Object.keys(DEEPSEEK_THINKING),
  },
];
const ID = /^[A-Za-z0-9][\w.:[\]-]{0,79}$/;
const EFFORT = /^[a-z]{1,10}$/;

/** @param {string} json */
export function readCodexModels(json) {
  const { models } = /** @type {{ models?: CodexModel[] }} */ (
    JSON.parse(json)
  );
  return (models || [])
    .filter((m) => m.visibility === "list" && ID.test(m.slug))
    .map((m) => ({
      id: m.slug,
      nombre: m.display_name || m.slug,
      esfuerzo: m.default_reasoning_level,
      esfuerzos: (m.supported_reasoning_levels || [])
        .map((l) => l.effort)
        .filter((e) => EFFORT.test(e)),
    }));
}

/** @param {string} output */
export function readAgyModels(output) {
  /** @type {Map<string, LauncherModel>} */
  const seen = new Map();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const m = /^(\S+)\t+(.+?)\s*$/.exec(line);
    if (m && ID.test(m[1])) seen.set(m[1], { id: m[1], nombre: m[2] });
  }
  return [...seen.values()];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>}
 */
function runAgy(env) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn("agy", ["models"], {
        cwd: env.HOME,
        env: environmentOf("gemini", env),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve("");
    }
    const clock = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (d) => (output += d));
    child.once("error", () => resolve(""));
    child.once("close", () => {
      clearTimeout(clock);
      resolve(output);
    });
  });
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, agy?: () => Promise<string>, leer?: (archivo: string) => Promise<string>, ahora?: () => number }} [options]
 */
export function createModelCatalog({
  env = process.env,
  agy = () => runAgy(env),
  leer: read = (file) => readFile(file, "utf8"),
  ahora = Date.now,
} = {}) {
  /** @type {{ en: number, valor: ModelCatalog } | null} */
  let cache = null;
  /** @returns {Promise<ModelCatalog>} */
  async function models() {
    if (cache && ahora() - cache.en < 10 * 60_000) return cache.valor;
    const [codex, lira] = await Promise.all([
      env.CODEX_HOME
        ? read(path.join(env.CODEX_HOME, "models_cache.json"))
            .then(readCodexModels)
            .catch(/** @returns {[]} */ () => [])
        : [],
      agy()
        .then(readAgyModels)
        .catch(/** @returns {[]} */ () => []),
    ]);
    const value = { claude: CLAUDE, codex, agy: lira, deepseek: DEEPSEEK };
    // A failed query is retried on the next request instead of being cached.
    if (codex.length && lira.length) cache = { en: ahora(), valor: value };
    return value;
  }
  /**
   * Rejects anything not offered right now: the values become CLI arguments.
   * @param {string | undefined} engine Unvalidated request field; unknown engines list no models.
   * @param {string | null} [modelo]
   * @param {string | null} [esfuerzo]
   */
  async function validate(engine, modelo, esfuerzo) {
    if (!modelo && !esfuerzo) return;
    const lista =
      (await models())[/** @type {LauncherEngine} */ (engine)] || [];
    // The program's default model accepts any effort its catalog offers.
    if (!modelo) {
      if (!esfuerzo || !lista.some((m) => m.esfuerzos?.includes(esfuerzo)))
        throw new Error("Modelo no disponible");
      return;
    }
    const chosen = lista.find((m) => m.id === modelo);
    if (!chosen) throw new Error("Modelo no disponible");
    if (esfuerzo && !chosen.esfuerzos?.includes(esfuerzo))
      throw new Error("Modelo no disponible");
  }
  return { modelos: models, validar: validate };
}
