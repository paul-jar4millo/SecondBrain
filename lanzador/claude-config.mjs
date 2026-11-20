import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { carpetaAgy, esLineaUso, lineaUso } from "./uso.mjs";

/** The owner's own status line wins: without it the agent just shows no bars. */
const lineaMedidora = (actual, motor, carpeta, firma) =>
  actual && !esLineaUso(actual) ? null : lineaUso(motor, carpeta, firma);

/**
 * An unattended harness cannot answer Claude Code's first-run dialogs, so the
 * folder is trusted and onboarding marked done in that agent's own config dir.
 * Each agent keeps its own directory: Marina never reads Ámbar's account.
 * `firma` puts the agent's name in the status line of its terminal; `medir` also
 * records the plan's limits, which only subscription accounts receive.
 */
export async function prepararClaude(
  configDir,
  cwd,
  { firma, medir } = /** @type {any} */ ({}),
) {
  if (!configDir || !cwd) return;
  await modificar(path.join(configDir, ".claude.json"), (datos) => {
    const proyecto = datos.projects?.[cwd] || {};
    if (datos.hasCompletedOnboarding && proyecto.hasTrustDialogAccepted)
      return false;
    datos.hasCompletedOnboarding = true;
    datos.projects = {
      ...datos.projects,
      [cwd]: { ...proyecto, hasTrustDialogAccepted: true },
    };
  });
  await modificar(path.join(configDir, "settings.json"), (datos) => {
    const linea = medir
      ? lineaMedidora(datos.statusLine, "claude", configDir, firma)
      : firma && {
          type: "command",
          command: `printf '%s' '${firma.replace(/'/g, "")}'`,
        };
    if (
      datos.skipDangerousModePermissionPrompt &&
      (!linea || JSON.stringify(datos.statusLine) === JSON.stringify(linea))
    )
      return false;
    datos.skipDangerousModePermissionPrompt = true;
    if (linea) datos.statusLine = linea;
  });
}

/**
 * Antigravity asks to trust every new folder before it reads input, so Lira's
 * first message would wait forever in a per-project workspace. Trust it first.
 * The limits line stacks under the built-in one instead of replacing it.
 */
export async function prepararAgy(home, cwd) {
  if (!home || !cwd) return;
  const carpeta = carpetaAgy(home);
  await modificar(path.join(carpeta, "settings.json"), (datos) => {
    const confiables = Array.isArray(datos.trustedWorkspaces)
      ? datos.trustedWorkspaces
      : [];
    const base = lineaMedidora(
      datos.statusLine,
      "agy",
      carpeta,
      "Lira · Antigravity",
    );
    const linea = base && { ...base, stack_with_default: true };
    if (
      confiables.includes(cwd) &&
      (!linea || JSON.stringify(datos.statusLine) === JSON.stringify(linea))
    )
      return false;
    if (!confiables.includes(cwd))
      datos.trustedWorkspaces = [...confiables, cwd];
    if (linea) datos.statusLine = linea;
  });
}

async function modificar(archivo, cambiar) {
  let datos = {};
  try {
    datos = JSON.parse(await readFile(archivo, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return; // never overwrite a config we cannot parse
  }
  if (cambiar(datos) === false) return;
  const temporal = `${archivo}.${process.pid}.tmp`;
  await writeFile(temporal, JSON.stringify(datos, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporal, archivo);
}
