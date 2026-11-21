// English identifiers convention (ADR 0007): finds file names and exported
// identifiers that contain Spanish words. `node ops/naming.mjs --legacy`
// prints the current findings in the format of ops/naming-legacy.json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  /^(contracts|discord|service|mcp|launcher|ops|dashboard\/src|dashboard\/ops)\/.*\.(mjs|js|ts|tsx|py|css)$/;
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

function trackedAndNewFiles() {
  return [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      ).split("\0"),
    ),
  ].filter((file) => file && existsSync(path.join(root, file)));
}

export function sourceFiles() {
  return trackedAndNewFiles().filter(
    (file) => SOURCE.test(file) && !SKIP.test(file),
  );
}

const operationalWords = new Set([
  "agregar",
  "aviso",
  "bandeja",
  "capacidad",
  "cliente",
  "conectar",
  "decidir",
  "detalle",
  "dentro",
  "entregable",
  "imagen",
  "matutino",
  "perfil",
  "plantilla",
  "prender",
  "recibo",
  "resumen",
  "revocar",
  "vinculo",
]);

/** @param {string} name */
function isSpanishOperationalName(name) {
  return words(name).some(
    (word) =>
      isSpanish(word) ||
      [word, word.replace(/s$/, ""), word.replace(/es$/, "")].some((form) =>
        operationalWords.has(form),
      ),
  );
}

const declarationFile =
  /^(?:service\/(?:routes\.mjs|http\/routes\/.*\.mjs)|launcher\/(?:index\.mjs|threads\/http\/routes\.ts))$/;
const unitFile = /\.(?:service|timer|socket|target|slice)$/;
const environmentSource =
  /\.(?:mjs|js|ts|tsx|py|sh|service|timer|conf|example|yml)$/;

/** @param {string} file @param {string} text */
export function operationalNamesIn(file, text) {
  const findings = new Set();
  const name = path.basename(file);
  if (
    file.startsWith("ops/") &&
    !SKIP.test(file) &&
    file.slice(4).split("/").some(isSpanishOperationalName)
  )
    findings.add("ops:" + file);
  if (unitFile.test(name) && isSpanishOperationalName(name))
    findings.add("unit:" + name);
  if (environmentSource.test(file) && !file.includes("/tests/"))
    for (const [name] of text.matchAll(/\bSB_[A-Z][A-Z0-9_]*\b/g))
      if (!name.endsWith("_") && isSpanishOperationalName(name.slice(3)))
        findings.add("env:" + name);
  if (declarationFile.test(file))
    for (const [, route] of text.matchAll(
      /["'`](?:GET|POST|PATCH|PUT|DELETE|HEAD) (\/[^"'\x60\s]+)["'`]/g,
    ))
      if (isSpanishOperationalName(route)) findings.add("route:" + route);
  if (file === "launcher/threads/http/routes.ts")
    for (const [, route] of text.matchAll(
      new RegExp("/\\^((?:\\\\/[^/$]+)+)\\$/", "g"),
    )) {
      const literal = route.replaceAll("\\/", "/").replace(/\([^)]*\)/g, "");
      if (isSpanishOperationalName(literal)) findings.add("route:" + literal);
    }
  return [...findings].sort();
}

/** P7 checks names introduced after the compatibility rollout began. */
export function operationalFindings() {
  return [
    ...new Set(
      trackedAndNewFiles().flatMap((file) => {
        if (
          !/^(?:service|launcher|ops|mcp|dashboard\/src|\.github\/workflows)\//.test(
            file,
          )
        )
          return [];
        return operationalNamesIn(
          file,
          environmentSource.test(file)
            ? readFileSync(path.join(root, file), "utf8")
            : "",
        );
      }),
    ),
  ].sort();
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
      !/^(contracts|discord|service|mcp|launcher|dashboard\/src)\//.test(
        file,
      ) ||
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes("--operational")
)
  console.log(JSON.stringify(operationalFindings(), null, 2));
