import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const base = "/var/lib/sb-agente";
const command =
  "/opt/node/bin/node " +
  (process.env.SB_REMOTE_CODE_ROOT || "/opt/secondbrain/current") +
  "/lanzador/remote-hook.mjs";

/**
 * @typedef {{ type: "command", command: string }} CommandHook
 * @typedef {{
 *   hooks?: Record<string, unknown[]>,
 *   "secondbrain-observer"?: Record<string, CommandHook[]>,
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
// Ámbar and Marina each run their own Claude Code config; both report state.
for (const dir of ["claude", "deepseek"])
  await update(`${base}/${dir}/settings.json`, (data) => {
    data.hooks ??= {};
    for (const [event, phase] of [
      ["SessionStart", "start"],
      ["UserPromptSubmit", "start"],
      ["Stop", "stop"],
    ]) {
      const existing = data.hooks[event] || [];
      data.hooks[event] = [
        ...existing.filter(
          (x) => !JSON.stringify(x).includes("/lanzador/remote-hook.mjs"),
        ),
        { hooks: [{ type: "command", command: command + " " + phase }] },
      ];
    }
  });
await update(base + "/.gemini/config/hooks.json", (data) => {
  data["secondbrain-observer"] = {
    SessionStart: [{ type: "command", command: command + " start" }],
    PreInvocation: [{ type: "command", command: command + " start" }],
    Stop: [{ type: "command", command: command + " stop" }],
  };
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
          p.startsWith("/srv/sb-agente/proyectos/") &&
          !p.includes("/../"),
      ),
    ]),
  ];
});
