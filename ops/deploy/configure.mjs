import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  chmod,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} DeploymentParameters
 * @property {string} proxy
 * @property {string} gateway
 * @property {string} pc
 * @property {string} broadcast
 * @property {number} agentUid
 * @property {string} mac
 * @property {string} remoteWorkdir
 */

/** @param {DeploymentParameters} p */
function validate(p) {
  for (const key of /** @type {const} */ ([
    "proxy",
    "gateway",
    "pc",
    "broadcast",
  ]))
    if (net.isIP(p[key]) !== 4)
      throw new Error("Invalid IPv4 parameter: " + key);
  for (const key of /** @type {const} */ (["agentUid"]))
    if (!Number.isInteger(p[key]) || p[key] < 1 || p[key] > 65534)
      throw new Error("Invalid UID: " + key);
  if (!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(p.mac))
    throw new Error("Invalid MAC");
  if (
    !/^\/srv\/(?:sb-agente\/proyectos|sb-agent\/projects)(?:\/[A-Za-z0-9_-]+)*$/.test(
      p.remoteWorkdir,
    )
  )
    throw new Error("Invalid remote working directory");
}
/** @param {string} text */
function canonicalUnit(text) {
  /** @type {Record<string, Record<string, string[]>>} */
  const sections = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = line;
      sections[section] ??= {};
      continue;
    }
    const at = line.indexOf("=");
    if (at < 0) return text;
    const key = line.slice(0, at);
    (sections[section][key] ??= []).push(line.slice(at + 1));
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(sections)
        .sort()
        .map(([name, keys]) => [
          name,
          Object.fromEntries(Object.entries(keys).sort()),
        ]),
    ),
  );
}
/**
 * @param {string} root
 * @param {string} absolute
 */
async function safeDestination(root, absolute) {
  const candidate = path.join(root, ...absolute.split("/").filter(Boolean));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Unsafe configuration path");
  let parent = root;
  for (const piece of relative.split(path.sep)) {
    parent = path.join(parent, piece);
    try {
      if ((await lstat(parent)).isSymbolicLink())
        throw new Error("Configuration path contains a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return candidate;
}
/** @param {{ root?: string, release: string, parameters: DeploymentParameters, check?: boolean, skipHelper?: boolean }} options */
export async function configure({
  root = "/",
  release,
  parameters,
  check = false,
  skipHelper = false,
}) {
  validate(parameters);
  root = await realpath(root);
  release = await realpath(release);
  const p = parameters;
  /** @param {string} text */
  const render = (text) =>
    text
      .replaceAll("@PROXY_IP@", p.proxy)
      .replaceAll("@GATEWAY@", p.gateway)
      .replaceAll("@UID@", String(p.agentUid))
      .replaceAll("@PC_IP@", p.pc)
      .replaceAll("@BROADCAST@", p.broadcast);
  const mapping = [
    [
      "ops/deploy/deploy-release.sh",
      "/usr/local/sbin/secondbrain-deploy",
      0o755,
    ],
    [
      "ops/lxc/plantillas/secondbrain.service",
      "/etc/systemd/system/secondbrain.service",
      0o644,
    ],
    ["ops/lxc/plantillas/nftables.conf", "/etc/nftables.conf", 0o644],
    ...[
      "secondbrain-lanzador.service",
      "claude-sb-agente.service",
      "resumen-matutino.service",
      "resumen-matutino.timer",
    ].map((name) => [
      "ops/lanzador/" + name,
      "/etc/systemd/system/" + name,
      0o644,
    ]),
    ...["secondbrain-vault-push.service", "secondbrain-vault-push.timer"].map(
      (name) => ["ops/deploy/" + name, "/etc/systemd/system/" + name, 0o644],
    ),
    ...["secondbrain-backup.service", "secondbrain-backup.timer"].map(
      (name) => ["ops/backup/" + name, "/etc/systemd/system/" + name, 0o644],
    ),
    [
      "ops/aviso/secondbrain-aviso@.service",
      "/etc/systemd/system/secondbrain-aviso@.service",
      0o644,
    ],
    ["ops/homelab/prender-pc", "/usr/local/bin/prender-pc", 0o755],
    ["ops/homelab/estado-pc", "/usr/local/bin/estado-pc", 0o755],
  ];
  const marker = await safeDestination(root, "/etc/secondbrain/english-layout");
  const english = await lstat(marker)
    .then((file) => file.isFile())
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const names = english ? await import("../migration/host-layout.mjs") : null;
  const files = await Promise.all(
    mapping
      .filter(
        (entry) =>
          !skipHelper || entry[1] !== "/usr/local/sbin/secondbrain-deploy",
      )
      .map(async (entry) => {
        const [source, target, mode] = /** @type {[string, string, number]} */ (
          entry
        );
        let content = render(
          await readFile(path.join(release, source), "utf8"),
        );
        if (target.endsWith("/claude-sb-agente.service"))
          content = content.replace(
            /^WorkingDirectory=.*$/m,
            "WorkingDirectory=" + p.remoteWorkdir,
          );
        const basename = target.split("/").at(-1);
        const renderedTarget =
          names && target.startsWith("/etc/systemd/system/") && basename
            ? target.slice(0, -basename.length) + names.hostUnitName(basename)
            : target;
        return {
          target:
            names?.HOST_COMMANDS.find(([from]) => from === target)?.[1] ??
            renderedTarget,
          mode,
          // The deploy helper handles both layouts itself and must stay verbatim.
          content:
            names && target !== "/usr/local/sbin/secondbrain-deploy"
              ? names.hostUnitText(content)
              : content,
        };
      }),
  );
  files.push({
    target: "/etc/sb-agente/pc.json",
    mode: 0o644,
    content:
      JSON.stringify(
        {
          host: p.pc,
          port: 445,
          mac: p.mac,
          broadcast: p.broadcast,
          wolPort: 9,
          deadlineMs: 120000,
        },
        null,
        2,
      ) + "\n",
  });
  files.push({
    target: "/etc/systemd/journald.conf.d/secondbrain.conf",
    mode: 0o644,
    content: "[Journal]\nSystemMaxUse=100M\nMaxRetentionSec=7day\n",
  });
  files.push({
    target: `/etc/systemd/system/user-${p.agentUid}.slice.d/resources.conf`,
    mode: 0o644,
    content: "[Slice]\nMemoryMax=3G\nTasksMax=384\nCPUQuota=150%\n",
  });
  let drift = 0;
  for (const item of files) {
    const dest = await safeDestination(root, item.target);
    if (check) {
      let same = false;
      try {
        const actual = await readFile(dest, "utf8");
        same = item.target.endsWith(".service")
          ? canonicalUnit(actual) === canonicalUnit(item.content)
          : actual === item.content;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!same) {
        console.error("Configuration drift: " + item.target);
        drift++;
      }
    } else {
      await mkdir(path.dirname(dest), { recursive: true });
      const temp = dest + "." + process.pid + ".tmp";
      await writeFile(temp, item.content, { flag: "wx", mode: item.mode });
      try {
        await chmod(temp, item.mode);
        await rename(temp, dest);
      } finally {
        await rm(temp, { force: true });
      }
    }
  }
  console.log(
    JSON.stringify({
      mode: check ? "check" : "install",
      files: files.length,
      drift,
    }),
  );
  return drift ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    /** @param {string} name */
    const value = (name) => {
      const at = args.indexOf(name);
      if (at < 0 || !args[at + 1]) throw new Error("Missing " + name);
      return args[at + 1];
    };
    process.exitCode = await configure({
      root: args.includes("--root") ? value("--root") : "/",
      release: value("--release"),
      parameters: JSON.parse(await readFile(value("--parameters"), "utf8")),
      check: args.includes("--check"),
      skipHelper: args.includes("--skip-helper"),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
