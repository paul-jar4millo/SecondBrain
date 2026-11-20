import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { agyFolder, isUsageLine, usageLine } from "./usage.mjs";

/** @typedef {{ command?: string, type?: string, stack_with_default?: boolean }} StatusLine */
/**
 * @typedef {{
 *   projects?: Record<string, { hasTrustDialogAccepted?: boolean }>,
 *   hasCompletedOnboarding?: boolean,
 *   statusLine?: StatusLine,
 *   skipDangerousModePermissionPrompt?: boolean,
 *   trustedWorkspaces?: string[],
 * }} ProviderConfig
 */

/**
 * The owner's own status line wins: without it the agent just shows no bars.
 * @param {StatusLine | undefined} actual
 * @param {string} engine
 * @param {string} folder
 * @param {string | undefined} signature
 */
const meterLine = (actual, engine, folder, signature) =>
  actual && !isUsageLine(actual) ? null : usageLine(engine, folder, signature);

/**
 * An unattended harness cannot answer Claude Code's first-run dialogs, so the
 * folder is trusted and onboarding marked done in that agent's own config dir.
 * Each agent keeps its own directory: Marina never reads Ámbar's account.
 * `firma` puts the agent's name in the status line of its terminal; `medir` also
 * records the plan's limits, which only subscription accounts receive.
 * @param {string | undefined} configDir
 * @param {string} cwd
 * @param {{ firma?: string, medir?: boolean }} [options]
 */
export async function prepareClaude(
  configDir,
  cwd,
  { firma: signature, medir: measure } = {},
) {
  if (!configDir || !cwd) return;
  await modify(path.join(configDir, ".claude.json"), (data) => {
    const project = data.projects?.[cwd] || {};
    if (data.hasCompletedOnboarding && project.hasTrustDialogAccepted)
      return false;
    data.hasCompletedOnboarding = true;
    data.projects = {
      ...data.projects,
      [cwd]: { ...project, hasTrustDialogAccepted: true },
    };
  });
  await modify(path.join(configDir, "settings.json"), (data) => {
    const line = measure
      ? meterLine(data.statusLine, "claude", configDir, signature)
      : signature && {
          type: "command",
          command: `printf '%s' '${signature.replace(/'/g, "")}'`,
        };
    if (
      data.skipDangerousModePermissionPrompt &&
      (!line || JSON.stringify(data.statusLine) === JSON.stringify(line))
    )
      return false;
    data.skipDangerousModePermissionPrompt = true;
    if (line) data.statusLine = line;
  });
}

/**
 * Antigravity asks to trust every new folder before it reads input, so Lira's
 * first message would wait forever in a per-project workspace. Trust it first.
 * The limits line stacks under the built-in one instead of replacing it.
 * @param {string | undefined} home
 * @param {string} cwd
 */
export async function prepareAgy(home, cwd) {
  if (!home || !cwd) return;
  const carpeta = agyFolder(home);
  await modify(path.join(carpeta, "settings.json"), (data) => {
    const trusted = Array.isArray(data.trustedWorkspaces)
      ? data.trustedWorkspaces
      : [];
    const base = meterLine(
      data.statusLine,
      "agy",
      carpeta,
      "Lira · Antigravity",
    );
    const line = base && { ...base, stack_with_default: true };
    if (
      trusted.includes(cwd) &&
      (!line || JSON.stringify(data.statusLine) === JSON.stringify(line))
    )
      return false;
    if (!trusted.includes(cwd)) data.trustedWorkspaces = [...trusted, cwd];
    if (line) data.statusLine = line;
  });
}

/**
 * @param {string} file
 * @param {(config: ProviderConfig) => boolean | void} change
 */
async function modify(file, change) {
  let data = {};
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return; // never overwrite a config we cannot parse
  }
  if (change(data) === false) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, file);
}
