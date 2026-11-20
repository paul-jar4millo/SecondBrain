// Inspection of Codex MCP configuration and launch arguments.
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileAsync } from "./shared.mjs";
import { INHERITED_DESKTOP_CONNECTORS } from "../../catalogo-herramientas.mjs";
import { parseCodexMcpServerEntries } from "./toml.mjs";

/**
 * @typedef {object} CodexConfigContext
 * @property {string | null} [systemCodexConfigDir]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {NodeJS.ProcessEnv} [operatorEnv]
 * @property {string} [codexHome]
 * @property {string} [codexProfile]
 * @property {boolean} [useCodexMcpList]
 */
/** @typedef {{ disableInheritedMcp?: boolean, session?: { esfuerzo?: string } }} CodexArgsContext */
/** @typedef {{ enabled: boolean, dottedUnoverridable?: boolean }} CodexMcpEntry */
/** @typedef {Map<string, CodexMcpEntry> | Set<string>} DiscoveredEntries */
/** @typedef {import("./shared.mjs").ProviderMcpServer} ProviderMcpServer */
/** @typedef {import("./shared.mjs").ProviderMcpServers} ProviderMcpServers */

/** @param {string} key */
function formatTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(String(key));
}

/**
 * @param {string} filePath
 * @param {string | null} [allowedRoot]
 * @returns {Promise<Map<string, CodexMcpEntry>>}
 */
async function inspectCodexConfigFile(filePath, allowedRoot = null) {
  let st;
  try {
    st = await lstat(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return new Map();
    throw new Error(
      `No se pudo verificar aislamiento MCP en ${path.basename(filePath)}: ${err.code || err.message}`,
      { cause: err },
    );
  }
  if (st.isSymbolicLink() && allowedRoot) {
    const [realRoot, realFile] = await Promise.all([
      realpath(allowedRoot),
      realpath(filePath),
    ]);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `Symlink inseguro en configuración Codex (${path.basename(filePath)})`,
      );
    }
  }
  const raw = await readFile(filePath, "utf8");
  return parseCodexMcpServerEntries(raw);
}

/** @param {CodexConfigContext} ctx */
function systemCodexDirs(ctx) {
  if (ctx.systemCodexConfigDir === null) return [];
  if (
    typeof ctx.systemCodexConfigDir === "string" &&
    ctx.systemCodexConfigDir
  ) {
    return [ctx.systemCodexConfigDir];
  }
  if (process.platform === "win32") {
    return [
      path.join(
        process.env.ProgramData || "C:\\ProgramData",
        "OpenAI",
        "Codex",
      ),
    ];
  }
  return ["/etc/codex"];
}

/** @param {string} startDir */
function ancestorDirectoriesUpToRoot(startDir) {
  const dirs = [];
  let cur = path.resolve(startDir);
  while (true) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** @param {string} bin */
function isOfficialCodexBinary(bin) {
  const base = path.basename(String(bin || "")).toLowerCase();
  return base === "codex" || base === "codex.exe";
}

/**
 * @param {string} bin
 * @param {CodexConfigContext} ctx
 */
async function queryOfficialCodexMcpList(bin, ctx) {
  const { stdout } = await execFileAsync(bin, ["mcp", "list", "--json"], {
    cwd: ctx.cwd || process.cwd(),
    env: ctx.env,
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const list = JSON.parse(stdout);
  if (!Array.isArray(list)) {
    throw new Error("Salida inesperada de `codex mcp list --json`");
  }
  /** @type {Map<string, CodexMcpEntry>} */
  const map = new Map();
  for (const item of list) {
    if (!item?.name) continue;
    map.set(String(item.name), { enabled: item.enabled !== false });
  }
  return map;
}

/** @param {CodexConfigContext} ctx */
export async function inspectCodexConfiguredMcps(ctx, bin = "codex") {
  /** @type {Map<string, CodexMcpEntry>} */
  const fileEntries = new Map();
  /** @param {Map<string, CodexMcpEntry>} srcMap */
  const mergeEntries = (srcMap) => {
    for (const [k, v] of srcMap.entries()) {
      fileEntries.set(k, v);
    }
  };

  for (const sysDir of systemCodexDirs(ctx)) {
    for (const fileName of ["config.toml", "managed_config.toml"]) {
      mergeEntries(await inspectCodexConfigFile(path.join(sysDir, fileName)));
    }
  }

  const homeDir =
    ctx.codexHome ||
    ctx.env?.CODEX_HOME ||
    ctx.operatorEnv?.CODEX_HOME ||
    (ctx.env?.HOME ||
    ctx.env?.USERPROFILE ||
    ctx.operatorEnv?.HOME ||
    ctx.operatorEnv?.USERPROFILE
      ? path.join(
          ctx.env?.HOME ||
            ctx.env?.USERPROFILE ||
            ctx.operatorEnv?.HOME ||
            ctx.operatorEnv?.USERPROFILE,
          ".codex",
        )
      : null);
  if (homeDir) {
    const homeCfgPath = path.join(homeDir, "config.toml");
    mergeEntries(await inspectCodexConfigFile(homeCfgPath, homeDir));
    if (ctx.codexProfile) {
      mergeEntries(
        await inspectCodexConfigFile(
          path.join(homeDir, `${ctx.codexProfile}.config.toml`),
          homeDir,
        ),
      );
    }
  }
  const effectiveHome =
    ctx.codexHome ||
    ctx.env?.CODEX_HOME ||
    ctx.env?.HOME ||
    ctx.env?.USERPROFILE ||
    ctx.operatorEnv?.CODEX_HOME ||
    ctx.operatorEnv?.HOME ||
    ctx.operatorEnv?.USERPROFILE ||
    null;
  const realOsHome = os.homedir();
  const homeOverridden =
    Boolean(effectiveHome) &&
    path.resolve(effectiveHome) !== path.resolve(realOsHome);
  if (ctx.cwd) {
    const ancestors = ancestorDirectoriesUpToRoot(ctx.cwd);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const dir = ancestors[i];
      if (homeOverridden && path.resolve(dir) === path.resolve(realOsHome)) {
        continue;
      }
      mergeEntries(
        await inspectCodexConfigFile(
          path.join(dir, ".codex", "config.toml"),
          dir,
        ),
      );
    }
  }

  if (
    ctx.useCodexMcpList === true ||
    (ctx.useCodexMcpList !== false && isOfficialCodexBinary(bin))
  ) {
    try {
      const cliEntries = await queryOfficialCodexMcpList(bin, ctx);
      for (const [k, v] of cliEntries.entries()) {
        const prev = fileEntries.get(k);
        fileEntries.set(k, {
          ...(prev || {}),
          ...v,
          enabled: prev?.enabled === true || v.enabled === true,
          ...(prev?.dottedUnoverridable || k.includes(".")
            ? { dottedUnoverridable: true }
            : {}),
        });
      }
    } catch (err) {
      if (ctx.useCodexMcpList === true || err?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  return fileEntries;
}

/**
 * @param {CodexArgsContext} ctx
 * @param {ProviderMcpServers} mcpServers
 * @param {DiscoveredEntries} [discoveredEntries]
 */
export function buildCodexArgs(ctx, mcpServers, discoveredEntries = new Map()) {
  const disableInherited = ctx.disableInheritedMcp !== false;
  if (!disableInherited) {
    return ["app-server", "--stdio"];
  }
  const args = [
    "app-server",
    "--stdio",
    "--disable",
    "apps",
    "-c",
    "features.apps=false",
    "-c",
    "features.codex_hooks=false",
    "-c",
    "thread_unload_delay_secs=0",
  ];
  if (ctx.session?.esfuerzo) {
    args.push("-c", `model_reasoning_effort="${ctx.session.esfuerzo}"`);
  }
  const entries =
    discoveredEntries instanceof Map
      ? discoveredEntries
      : new Map([...discoveredEntries].map((k) => [k, { enabled: true }]));
  for (const [key, meta] of entries.entries()) {
    if (Object.hasOwn(mcpServers, key)) continue;
    if (key.includes(".") || /[\r\n\0]/.test(key)) {
      if (meta?.enabled !== false) {
        throw new Error(
          `Identificador de servidor MCP no aislable de forma segura por CLI (-c): "${key}"`,
        );
      }
      continue;
    }
    args.push("-c", `mcp_servers.${formatTomlKey(key)}.enabled=false`);
  }
  const builtinNames = new Set([
    ...INHERITED_DESKTOP_CONNECTORS,
    "node_repl",
    "secondbrain",
  ]);
  for (const key of builtinNames) {
    if (Object.hasOwn(mcpServers, key) || entries.has(key)) continue;
    args.push("-c", `mcp_servers.${key}={command="disabled",enabled=false}`);
  }
  for (const [key, srv] of Object.entries(mcpServers)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new Error(`Identificador de servidor MCP inválido: ${key}`);
    }
    const safeCmd = JSON.stringify(String(srv.command || ""));
    const safeArgs = JSON.stringify(
      Array.isArray(srv.args) ? srv.args.map(String) : [],
    );
    const safeEnv =
      srv.env && typeof srv.env === "object"
        ? `{${Object.entries(srv.env)
            .map(([ek, ev]) => `${ek}=${JSON.stringify(String(ev))}`)
            .join(",")}}`
        : "{}";
    args.push(
      "-c",
      `mcp_servers.${key}={command=${safeCmd},args=${safeArgs},env=${safeEnv},enabled=true}`,
    );
  }
  return args;
}

/**
 * @param {ProviderMcpServers} mcpServers
 * @param {boolean} [disableInheritedMcp]
 * @param {DiscoveredEntries} [discoveredEntries]
 */
export function buildCodexThreadMcpConfig(
  mcpServers,
  disableInheritedMcp = true,
  discoveredEntries = new Map(),
) {
  /** @type {Record<`mcp_servers.${string}`, ProviderMcpServer & { enabled: boolean }>} */
  const entries = {};
  const mapEntries =
    discoveredEntries instanceof Map
      ? discoveredEntries
      : new Map([...discoveredEntries].map((k) => [k, { enabled: true }]));
  if (disableInheritedMcp !== false) {
    for (const [key, meta] of mapEntries.entries()) {
      if (!Object.hasOwn(mcpServers, key) && !key.includes(".")) {
        entries[`mcp_servers.${key}`] = { enabled: false };
      } else if (!Object.hasOwn(mcpServers, key) && meta?.enabled !== false) {
        entries[`mcp_servers.${JSON.stringify(key)}`] = { enabled: false };
      }
    }
    for (const key of [
      ...INHERITED_DESKTOP_CONNECTORS,
      "node_repl",
      "secondbrain",
    ]) {
      if (!Object.hasOwn(mcpServers, key) && !mapEntries.has(key)) {
        entries[`mcp_servers.${key}`] = { command: "disabled", enabled: false };
      }
    }
  }
  for (const [name, server] of Object.entries(mcpServers)) {
    entries[`mcp_servers.${name}`] = { ...server, enabled: true };
  }
  return entries;
}
