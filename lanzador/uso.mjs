// @ts-check
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
import { ventanasAgy, ventanasClaude, ventanasCodex } from "./motores.mjs";

// Only the end of a rollout matters: Codex writes its limits after every turn.
const COLA = 512 * 1024;
const MAX_ARCHIVOS = 6;
const VIGENCIA = 30_000;

/** Latest account limits in a rollout; only numbers leave this function. */
export function ultimoUsoCodex(texto) {
  const lineas = texto.split("\n");
  for (let i = lineas.length - 1; i >= 0; i--) {
    if (!lineas[i].includes('"rate_limits"')) continue;
    let evento;
    try {
      evento = JSON.parse(lineas[i]);
    } catch {
      continue; // The tail can start in the middle of a line.
    }
    const limites = evento.payload?.rate_limits;
    if (!limites || (limites.limit_id && limites.limit_id !== "codex"))
      continue;
    const ventanas = ventanasCodex(limites);
    if (Object.keys(ventanas).length)
      return {
        ventanas,
        actualizado: evento.timestamp || null,
        plan: typeof limites.plan_type === "string" ? limites.plan_type : null,
      };
  }
  return null;
}

/** A window that already reset is empty, even if no session has said so yet. */
export function vigente(uso, ahora = Date.now()) {
  if (!uso) return null;
  const ventanas = {};
  for (const [id, v] of Object.entries(uso.ventanas))
    ventanas[id] =
      v.reinicia && Date.parse(v.reinicia) <= ahora
        ? { usado: 0, reinicia: null, agotada: false }
        : v;
  return { ...uso, ventanas };
}

async function carpetasRecientes(dir, profundidad) {
  const nombres = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const carpetas = nombres
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => e.name)
    .sort()
    .reverse();
  if (profundidad === 0) return [dir];
  const halladas = [];
  for (const nombre of carpetas) {
    halladas.push(
      ...(await carpetasRecientes(path.join(dir, nombre), profundidad - 1)),
    );
    if (halladas.length >= 2) break;
  }
  return halladas;
}

async function cola(archivo) {
  const manejador = await open(archivo, "r");
  try {
    const { size } = await manejador.stat();
    const largo = Math.min(size, COLA);
    const buffer = Buffer.alloc(largo);
    await manejador.read(buffer, 0, largo, size - largo);
    return buffer.toString("utf8");
  } finally {
    await manejador.close();
  }
}

/** Reads what Codex already recorded: asking its servers would spend nothing, but needs a process. */
export async function leerUsoCodex(sesiones) {
  // sessions/YYYY/MM/DD/rollout-*.jsonl
  const archivos = [];
  for (const dir of await carpetasRecientes(sesiones, 3))
    for (const nombre of await readdir(dir).catch(() => []))
      if (/^rollout-.*\.jsonl$/.test(nombre)) {
        const completo = path.join(dir, nombre);
        const info = await stat(completo).catch(() => null);
        if (info?.isFile()) archivos.push({ completo, cambio: info.mtimeMs });
      }
  archivos.sort((a, b) => b.cambio - a.cambio);
  for (const { completo } of archivos.slice(0, MAX_ARCHIVOS)) {
    const uso = ultimoUsoCodex(await cola(completo).catch(() => ""));
    if (uso) return uso;
  }
  return null;
}

// Claude Code and Antigravity only hand their limits to the status line, so a
// small command keeps the numbers next to each CLI's own configuration.
const ARCHIVO_LINEA = "sb-uso.json";
const LECTORES_LINEA = {
  claude: (datos) => ventanasClaude(datos?.rate_limits),
  agy: (datos) => ventanasAgy(datos?.quota, datos?.model?.id),
};
export function contextoLinea(datos) {
  const ventana = datos?.context_window;
  const uso = ventana?.current_usage;
  let usados =
    uso &&
    [
      "input_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "output_tokens",
    ].reduce((n, k) => n + (Number(uso[k]) || 0), 0);
  if (
    !usados &&
    Number.isFinite(ventana?.context_window_size) &&
    Number.isFinite(ventana?.used_percentage)
  )
    usados = Math.round(
      (ventana.context_window_size * ventana.used_percentage) / 100,
    );
  return Number.isFinite(usados) && usados > 0
    ? { usados, limite: 400000 }
    : null;
}
const comillas = (texto) => `'${String(texto).replace(/'/g, "")}'`;

export const carpetaAgy = (home) => path.join(home, ".gemini/antigravity-cli");

/** The status line command for an agent; it only runs locally and spends no quota. */
export const lineaUso = (motor, carpeta, firma) => ({
  type: "command",
  command: [
    process.execPath,
    fileURLToPath(new URL("./uso-linea.mjs", import.meta.url)),
    motor,
    path.join(carpeta, ARCHIVO_LINEA),
    firma,
  ]
    .map(comillas)
    .join(" "),
});

export const esLineaUso = (linea) =>
  String(linea?.command).includes("uso-linea.mjs");

export async function leerUsoLinea(archivo) {
  let datos;
  try {
    datos = JSON.parse(await readFile(archivo, "utf8"));
  } catch {
    return null;
  }
  const ventanas = {};
  for (const id of ["5h", "semanal"]) {
    const v = datos?.ventanas?.[id];
    if (typeof v?.usado === "number" && Number.isFinite(v.usado))
      ventanas[id] = {
        usado: v.usado,
        reinicia: typeof v.reinicia === "string" ? v.reinicia : null,
        agotada: v.usado >= 100,
      };
  }
  const contexto =
    Number.isFinite(datos?.contexto?.usados) && datos.contexto.usados > 0
      ? { usados: datos.contexto.usados, limite: 400000 }
      : null;
  return Object.keys(ventanas).length || contexto
    ? {
        ventanas,
        ...(contexto
          ? { contexto, contextoActualizado: datos.contextoActualizado }
          : {}),
        actualizado:
          typeof datos.actualizado === "string" ? datos.actualizado : null,
      }
    : null;
}

/**
 * Keeps only the numbers of a status line payload, which also carries paths and
 * the account's email. A window the CLI stopped sending stays: `vigente` empties it.
 */
export async function guardarUsoLinea(
  motor,
  datos,
  archivo,
  ahora = Date.now(),
) {
  const ventanas = LECTORES_LINEA[motor]?.(datos);
  const contexto = contextoLinea(datos);
  if ((!ventanas || !Object.keys(ventanas).length) && !contexto) return false;
  const previo = await leerUsoLinea(archivo);
  const temporal = `${archivo}.tmp`;
  await mkdir(path.dirname(archivo), { recursive: true });
  await writeFile(
    temporal,
    JSON.stringify({
      ventanas: { ...previo?.ventanas, ...ventanas },
      actualizado: Object.keys(ventanas || {}).length
        ? new Date(ahora).toISOString()
        : previo?.actualizado,
      ...(contexto
        ? { contexto, contextoActualizado: new Date(ahora).toISOString() }
        : previo?.contexto
          ? {
              contexto: previo.contexto,
              contextoActualizado: previo.contextoActualizado,
            }
          : {}),
    }),
    { mode: 0o600 },
  );
  await rename(temporal, archivo);
  return true;
}

export function crearUso({ env = process.env, ahora = Date.now } = {}) {
  let memoria = null;
  return async function uso() {
    if (!memoria || ahora() - memoria.en > VIGENCIA) {
      const raiz =
        env.CODEX_HOME || (env.HOME && path.join(env.HOME, ".codex"));
      memoria = {
        en: ahora(),
        codex: raiz
          ? await leerUsoCodex(path.join(raiz, "sessions")).catch(() => null)
          : null,
        claude: env.AGENTES_CLAUDE_DIR
          ? await leerUsoLinea(path.join(env.AGENTES_CLAUDE_DIR, ARCHIVO_LINEA))
          : null,
        agy: env.HOME
          ? await leerUsoLinea(path.join(carpetaAgy(env.HOME), ARCHIVO_LINEA))
          : null,
      };
    }
    const resultado = {};
    for (const motor of ["codex", "claude", "agy"]) {
      const actual = vigente(memoria[motor], ahora());
      if (actual) resultado[motor] = actual;
    }
    return resultado;
  };
}
