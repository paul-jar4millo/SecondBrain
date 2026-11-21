// Engine settings of the agent user. The session-era state hooks are gone
// (ADR 0010): threads read state from the provider events, so old entries
// are removed. Antigravity trusts only the project folders.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const base = "/var/lib/sb-agente";
const LEGACY_HOOK = "/lanzador/remote-hook.mjs";

/**
 * @typedef {{
 *   hooks?: Record<string, unknown[]>,
 *   "secondbrain-observer"?: unknown,
 *   trustedWorkspaces?: string[],
 * }} RemoteSettings
 */

/**
 * @param {string} file
 * @param {(data: RemoteSettings) => void} modify
 */
async function update(file, modify) {
  await mkdir(path.dirname(file), { recursive: true });
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    data = {};
  }
  modify(data);
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
for (const dir of ["claude", "deepseek"])
  await update(`${base}/${dir}/settings.json`, (data) => {
    if (!data.hooks) return;
    for (const [event, entries] of Object.entries(data.hooks)) {
      const kept = entries.filter(
        (x) =>
          !JSON.stringify(x).includes(LEGACY_HOOK) &&
          !JSON.stringify(x).includes("/server/hook.mjs"),
      );
      if (kept.length) data.hooks[event] = kept;
      else delete data.hooks[event];
    }
    if (!Object.keys(data.hooks).length) delete data.hooks;
  });
await update(base + "/.gemini/config/hooks.json", (data) => {
  delete data["secondbrain-observer"];
});
const projects = JSON.parse(
  await readFile("/etc/sb-agente/proyectos.json", "utf8"),
);
await update(base + "/.gemini/antigravity-cli/settings.json", (data) => {
  data.trustedWorkspaces = [
    ...new Set([
      ...(data.trustedWorkspaces || []),
      ...Object.values(projects).filter(
        (p) =>
          typeof p === "string" &&
          p.startsWith("/srv/sb-agent/projects/") &&
          !p.includes("/../"),
      ),
    ]),
  ];
});
