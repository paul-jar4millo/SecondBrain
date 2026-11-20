// Helpers shared by every provider controller: MCP servers, input formatting, artifacts and child processes.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../lib/hash.mjs";

export const execFileAsync = promisify(execFile);

export function profileDisallowsAction(ctx, category) {
  const ops = ctx?.toolProfile?.allowedOperations;
  if (!Array.isArray(ops)) return false;
  const set = new Set(ops);
  if (category === "write") return !set.has("file.write");
  if (category === "shell") return !set.has("shell.test");
  if (category === "web") return !set.has("web.read");
  return false;
}

export const text = (value) =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

export const exitedChildren = new WeakSet();
export function trackChildExit(child) {
  if (!child || typeof child.once !== "function") return child;
  child.once("exit", () => exitedChildren.add(child));
  return child;
}

export function brainServer(env = {}) {
  if (!env.SB_BRAIN_TOKEN_FILE) return {};
  return {
    secondbrain: {
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/index.mjs", import.meta.url))],
      env: Object.fromEntries(
        ["SB_BRAIN_TOKEN_FILE", "SB_BRAIN_URL", "SB_AGENTE", "SB_SESSION_ID"]
          .filter((key) => env[key])
          .map((key) => [key, env[key]]),
      ),
    },
  };
}

export function resolveMcpServers(ctx) {
  if (ctx.mcpServers === null) return {};
  if (
    ctx.mcpServers &&
    typeof ctx.mcpServers === "object" &&
    !Array.isArray(ctx.mcpServers)
  ) {
    return ctx.mcpServers;
  }
  return brainServer(ctx.env);
}

export function formatCodexInput(prompt, attachments = []) {
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [{ type: "text", text: prompt }];
  for (const att of attachments) {
    if (att.type === "text") blocks.push({ type: "text", text: att.text });
    else if (att.type === "localImage" && att.path)
      blocks.push({ type: "localImage", path: att.path });
    else if (att.type === "image" && (att.url || att.path))
      blocks.push({ type: "image", url: att.url || att.path });
  }
  return blocks;
}

export function formatAcpInput(prompt, attachments = []) {
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [{ type: "text", text: prompt }];
  for (const att of attachments) {
    if (att.type === "text") blocks.push({ type: "text", text: att.text });
    else if (att.type === "image")
      blocks.push({
        type: "image",
        ...(att.url ? { uri: att.url } : { uri: att.path }),
        ...(att.mimeType ? { mimeType: att.mimeType } : {}),
      });
    else if (att.type === "embeddedContext")
      blocks.push({
        type: "resource",
        resource: {
          uri: att.uri || att.path || att.ref || "",
          text: att.text || "",
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
        },
      });
  }
  return blocks;
}

export function verifyAcpConfigModel(
  configOptions,
  requestedModel,
  { throwOnMismatch = true } = {},
) {
  if (!Array.isArray(configOptions) || !requestedModel) return null;
  const modelOpt = configOptions.find(
    (o) => o?.category === "model" || o?.id === "model",
  );
  const thoughtOpt = configOptions.find(
    (o) => o?.category === "thought_level" || o?.id === "thought_level",
  );
  const family =
    typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : null;
  if (!family) return null;
  const thought =
    typeof thoughtOpt?.currentValue === "string"
      ? thoughtOpt.currentValue
      : null;
  const combined = thought ? `${family}-${thought}` : family;
  if (requestedModel !== family && requestedModel !== combined) {
    if (!throwOnMismatch) return combined;
    throw new Error(
      `Antigravity aplicó el modelo "${combined}" en lugar de "${requestedModel}"`,
    );
  }
  return requestedModel === family ? family : combined;
}

const SENSITIVE_ARTIFACT_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".codex",
  ".claude",
  ".gemini",
]);

function isUnsafeArtifactPath(relNormalized) {
  const parts = relNormalized.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.some((p) => SENSITIVE_ARTIFACT_SEGMENTS.has(p.toLowerCase()))) {
    return true;
  }
  const base = parts[parts.length - 1].toLowerCase();
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "auth.json" ||
    base === "settings.json" ||
    base.startsWith("id_rsa") ||
    base.startsWith("id_ed25519") ||
    /\.(pem|key|p12|pfx)$/i.test(base) ||
    /(secret|token|credential)/i.test(base)
  ) {
    return true;
  }
  return false;
}

function inferArtifactMimeType(fileRef) {
  const ext = path.extname(fileRef).toLowerCase();
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".txt" || ext === ".log") return "text/plain; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  return "application/octet-stream";
}

export async function publishVerifiedWorkspaceArtifact({
  ctx,
  cwd,
  rawPath,
  evidenceRefs = [],
  comment = "",
  publishedKeys = null,
}) {
  if (
    !ctx?.artifact ||
    !cwd ||
    typeof rawPath !== "string" ||
    !rawPath.trim()
  ) {
    return null;
  }
  if (rawPath.includes("\0")) return null;
  const trimmed = rawPath.trim();
  const realCwd = await realpath(cwd).catch(() => null);
  if (!realCwd) return null;

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(cwd, trimmed);
  const relRaw = path.relative(path.resolve(cwd), candidate);
  if (!relRaw || relRaw.startsWith("..") || path.isAbsolute(relRaw)) {
    return null;
  }
  const relNormalized = relRaw.replace(/\\/g, "/");
  if (isUnsafeArtifactPath(relNormalized)) return null;

  // Verify every existing component along relative path is not a symlink escaping cwd.
  let probe = path.resolve(cwd);
  for (const segment of relNormalized.split("/")) {
    probe = path.join(probe, segment);
    const segStat = await lstat(probe).catch(() => null);
    if (!segStat || segStat.isSymbolicLink()) {
      return null;
    }
  }

  const realTarget = await realpath(candidate).catch(() => null);
  if (!realTarget) return null;
  const relReal = path.relative(realCwd, realTarget);
  if (!relReal || relReal.startsWith("..") || path.isAbsolute(relReal)) {
    return null;
  }
  const finalStat = await lstat(realTarget).catch(() => null);
  if (
    !finalStat ||
    !finalStat.isFile() ||
    finalStat.isSymbolicLink() ||
    finalStat.size > 16 * 1024 * 1024
  ) {
    return null;
  }

  const buf = await readFile(realTarget);
  const sha256 = sha256Hex(buf);
  const evidenceKey = `${evidenceRefs.join("|")}:${relNormalized}:${sha256}`;
  if (publishedKeys?.has(evidenceKey)) return null;
  publishedKeys?.add(evidenceKey);

  await ctx.artifact({
    fileRef: relNormalized,
    fileName: path.basename(relNormalized),
    sha256,
    contentBuffer: buf,
    byteLength: buf.length,
    mimeType: inferArtifactMimeType(relNormalized),
    summary: comment || `Artefacto publicado (${relNormalized})`,
    comment: comment || "",
    evidenceRefs,
  });
  return { fileRef: relNormalized, sha256, byteLength: buf.length };
}

export function waitChildExit(child, timeoutMs = 1500) {
  if (
    !child ||
    exitedChildren.has(child) ||
    (child.exitCode !== null && child.exitCode !== undefined)
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function prepareAcpLaunchSpec(ctx) {
  const bin = ctx.operatorEnv?.SB_AGY_ACP_BIN || "agy";
  const mcpServers = resolveMcpServers(ctx);
  const servers = Object.entries(mcpServers).map(([name, s]) => ({
    ...s,
    name,
    env: Object.entries(s.env || {}).map(([key, value]) => ({
      name: key,
      value: String(value),
    })),
  }));
  const spawnEnv = { ...(ctx.env || {}) };
  let args;
  let isolatedDir = null;
  let cleanupDir = null;
  if (ctx.operatorEnv?.SB_AGY_ACP_ARGS) {
    args = JSON.parse(ctx.operatorEnv.SB_AGY_ACP_ARGS);
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new Error("Configuración ACP inválida");
    }
  } else {
    isolatedDir =
      ctx.geminiDir ||
      path.join(os.tmpdir(), "sb-acp-runtime", ctx.session?.id || randomUUID());
    cleanupDir = ctx.geminiDir ? null : isolatedDir;
    await mkdir(path.join(isolatedDir, "config"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path.join(isolatedDir, "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: {} }, null, 2),
      { mode: 0o600 },
    );
    delete spawnEnv.AGY_ACP_FORCE_FILE_STORAGE;
    delete spawnEnv.GEMINI_API_KEY;
    delete spawnEnv.GOOGLE_API_KEY;
    spawnEnv.GEMINI_HOME = isolatedDir;
    spawnEnv.BROWSER = `${process.execPath.replace(/\\/g, "/")} -e "process.exit(1)"`;
    args = [
      "acp",
      "--gemini-dir",
      isolatedDir,
      "--include-default-customizations=false",
      "--disable-telemetry",
      ...(ctx.acpLogFile ? ["--cli_log_file", ctx.acpLogFile] : []),
    ];
  }
  return { bin, args, env: spawnEnv, servers, isolatedDir, cleanupDir };
}
