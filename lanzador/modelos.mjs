import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { entornoDe, DEEPSEEK_MODEL, PENSAMIENTO_DEEPSEEK } from "./motores.mjs";

// What each CLI offers on this server, so a session can run on a chosen model.
// An empty list only means «the program's default»; it never blocks a session.
// Effort levels accepted by `claude --effort`: the current Opus, Sonnet and Haiku
// all take the five levels.
const ESFUERZOS_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE = [
  { id: "opus", nombre: "Opus", esfuerzos: ESFUERZOS_CLAUDE },
  { id: "sonnet", nombre: "Sonnet", esfuerzos: ESFUERZOS_CLAUDE },
  { id: "haiku", nombre: "Haiku", esfuerzos: ESFUERZOS_CLAUDE },
];
// Marina has a single model; its effort becomes a thinking budget.
const DEEPSEEK = [
  {
    id: DEEPSEEK_MODEL,
    nombre: "DeepSeek Flash",
    esfuerzos: Object.keys(PENSAMIENTO_DEEPSEEK),
  },
];
const ID = /^[A-Za-z0-9][\w.:[\]-]{0,79}$/;
const ESFUERZO = /^[a-z]{1,10}$/;

export function leerModelosCodex(json) {
  return (JSON.parse(json).models || [])
    .filter((m) => m.visibility === "list" && ID.test(m.slug))
    .map((m) => ({
      id: m.slug,
      nombre: m.display_name || m.slug,
      esfuerzo: m.default_reasoning_level,
      esfuerzos: (m.supported_reasoning_levels || [])
        .map((l) => l.effort)
        .filter((e) => ESFUERZO.test(e)),
    }));
}

export function leerModelosAgy(salida) {
  const vistos = new Map();
  for (const linea of salida.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const m = /^(\S+)\t+(.+?)\s*$/.exec(linea);
    if (m && ID.test(m[1])) vistos.set(m[1], { id: m[1], nombre: m[2] });
  }
  return [...vistos.values()];
}

function correrAgy(env) {
  return new Promise((resolve) => {
    let salida = "";
    let hijo;
    try {
      hijo = spawn("agy", ["models"], {
        cwd: env.HOME,
        env: entornoDe("gemini", env),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve("");
    }
    const reloj = setTimeout(() => hijo.kill(), 20000);
    hijo.stdout.on("data", (d) => (salida += d));
    hijo.once("error", () => resolve(""));
    hijo.once("close", () => {
      clearTimeout(reloj);
      resolve(salida);
    });
  });
}

export function crearCatalogo({
  env = process.env,
  agy = () => correrAgy(env),
  leer = (archivo) => readFile(archivo, "utf8"),
  ahora = Date.now,
} = {}) {
  let cache = null;
  async function modelos() {
    if (cache && ahora() - cache.en < 10 * 60_000) return cache.valor;
    const [codex, lira] = await Promise.all([
      env.CODEX_HOME
        ? leer(path.join(env.CODEX_HOME, "models_cache.json"))
            .then(leerModelosCodex)
            .catch(() => [])
        : [],
      agy()
        .then(leerModelosAgy)
        .catch(() => []),
    ]);
    const valor = { claude: CLAUDE, codex, agy: lira, deepseek: DEEPSEEK };
    // A failed query is retried on the next request instead of being cached.
    if (codex.length && lira.length) cache = { en: ahora(), valor };
    return valor;
  }
  /** Rejects anything not offered right now: the values become CLI arguments. */
  async function validar(motor, modelo, esfuerzo) {
    if (!modelo && !esfuerzo) return;
    const lista = (await modelos())[motor] || [];
    // The program's default model accepts any effort its catalog offers.
    if (!modelo) {
      if (!lista.some((m) => m.esfuerzos?.includes(esfuerzo)))
        throw new Error("Modelo no disponible");
      return;
    }
    const elegido = lista.find((m) => m.id === modelo);
    if (!elegido) throw new Error("Modelo no disponible");
    if (esfuerzo && !elegido.esfuerzos?.includes(esfuerzo))
      throw new Error("Modelo no disponible");
  }
  return { modelos, validar };
}
