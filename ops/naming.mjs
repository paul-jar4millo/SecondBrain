// English identifiers convention (ADR 0007): finds file names and exported
// identifiers that contain Spanish words. `node ops/naming.mjs --legacy`
// prints the current findings in the format of ops/naming-legacy.json.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

/** Common Spanish words of this codebase, without accents, singular. */
export const SPANISH = new Set(
  `accion acciones abrir actualizar agente aislamiento aprobacion arranque
  borrar buscar cancelar catalogo cerrar cola conversacion continuar crear
  cuarto cuenta diagnostico efecto ejecucion ejecutor eliminar encargo entrega
  equipo errores espacio esperar estado fase flujo guardar herramienta
  hilo iniciar integrante lanzador leer manifiesto mensaje modelo motor mundo
  nota nuevo personaje preparar proyecto refugio registro remoto sala saldo
  seguimiento sesion solicitud tablero tarea ultimo uso validar verificar`.split(
    /\s+/,
  ),
);

// Folders whose source files follow the convention.
const SOURCE =
  /^(service|mcp|launcher|ops|dashboard\/src|dashboard\/ops)\/.*\.(mjs|js|ts|tsx|py|css)$/;
const SKIP = /(^|\/)(node_modules|dist|fixtures)\/|^ops\/compat\//;

/** @param {string} name */
export const words = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** @param {string} word */
export const isSpanish = (word) =>
  SPANISH.has(word) ||
  (word.endsWith("es") && SPANISH.has(word.slice(0, -2))) ||
  (word.endsWith("s") && SPANISH.has(word.slice(0, -1)));

/** @param {string} name */
export const spanishWords = (name) => words(name).filter(isSpanish);

export function sourceFiles() {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => SOURCE.test(f) && !SKIP.test(f));
}

/** Findings as "file" or "file#identifier". */
export function findings() {
  const out = [];
  for (const file of sourceFiles()) {
    const base = path
      .basename(file)
      .replace(/\.(test\.)?(mjs|js|ts|tsx|d\.ts|py|css)$/, "");
    if (spanishWords(base).length) out.push(file);
    // Exported identifiers of the backend modules.
    if (
      !/^(service|mcp|launcher|dashboard\/src)\//.test(file) ||
      file.includes("/tests/")
    )
      continue;
    const text = readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(
      /^export (?:async )?(?:function\*? |const |let |class |type |interface )([A-Za-z_$][\w$]*)/gm,
    ))
      if (spanishWords(m[1]).length) out.push(`${file}#${m[1]}`);
  }
  return out.sort();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes("--legacy")
)
  console.log(JSON.stringify(findings(), null, 2));
