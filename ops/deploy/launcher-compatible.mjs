import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATES = new Set([
  "pendiente",
  "trabajando",
  "terminada",
  "error",
  "cancelada",
  "interrumpida",
]);

async function requiredVersion(index) {
  let sessions;
  try {
    sessions = JSON.parse(await readFile(index, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return 1; // Fresh installation, no durable index yet.
    throw new Error("No se pudo validar el índice del lanzador.", {
      cause: error,
    });
  }
  if (
    !Array.isArray(sessions) ||
    sessions.some(
      (s) =>
        !s ||
        typeof s !== "object" ||
        typeof s.id !== "string" ||
        !s.id ||
        !STATES.has(s.estado) ||
        (Object.hasOwn(s, "_detalle") &&
          (typeof s._detalle !== "string" ||
            !/^[a-f0-9]{64}\.json$/.test(s._detalle))),
    )
  )
    throw new Error("Índice del lanzador inválido.");
  return sessions.some((s) => Object.hasOwn(s, "_detalle")) ? 2 : 1;
}

async function supports(release, required) {
  if (
    !release ||
    !(await stat(release)
      .then((s) => s.isDirectory())
      .catch(() => false))
  )
    return false;
  if (required === 1) return true;
  // This is a static capability marker, never import or execute release code.
  const marker = await readFile(
    path.join(release, "lanzador/registro-version.mjs"),
    "utf8",
  ).catch(() => "");
  // Only line comments may precede the export; any other statement is rejected.
  const version =
    /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*\s*export const REGISTRO_VERSION = ([1-9]\d*);\s*$/.exec(
      marker,
    )?.[1];
  return Number(version) >= required;
}

export async function selectLauncherRelease(index, candidates) {
  const required = await requiredVersion(index);
  for (const candidate of candidates)
    if (await supports(candidate, required)) return candidate;
  throw new Error("Lanzador incompatible con el índice persistido.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] === "--select") {
      if (process.argv.length < 5) throw new Error();
      console.log(
        await selectLauncherRelease(process.argv[3], process.argv.slice(4)),
      );
    } else {
      if (process.argv.length !== 4) throw new Error();
      await selectLauncherRelease(process.argv[3], [process.argv[2]]);
    }
  } catch {
    console.error(
      "Lanzador pendiente: release incompatible o índice no verificable. Conservar la release compatible y revisar antes de reiniciar.",
    );
    process.exitCode = 1;
  }
}
