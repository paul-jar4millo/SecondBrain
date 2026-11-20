// Builds what a provider controller needs for one thread turn: the agent
// environment, MCP servers, tool profile and a spawn that runs the CLI in
// its own systemd scope (ADR 0003). Reuses the session-era helpers.
import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { effortEnvironment, environmentOf } from "../engines.mjs";
import { PROVIDER_BY_ENGINE } from "../execution/process-tools.mjs";
import { sessionCommand, stopSessionScope } from "../limits.mjs";
import { TOOL_PROFILES_BASE } from "../tool-catalog-data.mjs";
import { buildMcpConfigForProfile } from "../tool-catalog.mjs";

/** @typedef {import("../tool-catalog-types.d.ts").ToolProfile} ToolProfile */

const MCP_ACTOR = /** @type {Record<string, string>} */ ({
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
});

/** systemd unit names accept [a-z0-9-]; thread ids use an underscore. */
export const scopeIdOf = (/** @type {string} */ threadId) =>
  threadId.replace(/_/g, "-");

/**
 * Read-only stages (reviews) cannot write files or run shell commands.
 * @param {ToolProfile} profile
 * @param {boolean} readOnly
 * @returns {ToolProfile}
 */
export function profileFor(profile, readOnly) {
  const copy = structuredClone(profile);
  if (readOnly)
    copy.allowedOperations = copy.allowedOperations.filter(
      (/** @type {string} */ op) =>
        !["file.write", "shell.test", "git.local"].includes(op),
    );
  return copy;
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   sanitizeChildEnv: (env: NodeJS.ProcessEnv, profile: ToolProfile, tokenFile: string | null, billing: boolean, engine: string) => NodeJS.ProcessEnv,
 *   acpGeminiDirFor: (id: string) => string,
 *   toolCatalog?: { getProfile(id: string): ToolProfile | null | undefined } | null,
 *   spawn?: typeof nodeSpawn,
 *   tokenDir?: string | null,
 * }} deps
 */
export function createProviderContextFactory({
  env,
  sanitizeChildEnv,
  acpGeminiDirFor,
  toolCatalog = null,
  spawn = nodeSpawn,
  tokenDir = null,
}) {
  const tokenFileOf = (/** @type {string} */ threadId) =>
    tokenDir ? path.join(tokenDir, `${threadId}.token`) : null;
  /** @param {string} threadId */
  const existingTokenFile = async (threadId) => {
    const file = tokenFileOf(threadId);
    if (!file) return null;
    return access(file).then(
      () => file,
      () => null,
    );
  };
  /**
   * @param {{ threadId: string, agent: { engine: string, model?: string, effort?: string }, cwd: string, readOnly: boolean }} input
   */
  async function buildAgentContext({ threadId, agent, cwd, readOnly }) {
    const scopeId = scopeIdOf(threadId);
    const engine = agent.engine;
    const tokenFile = await existingTokenFile(threadId);
    const billingGranted =
      engine !== "deepseek" || env.SB_ALLOW_BILLED_DEEPSEEK === "1";
    const base =
      toolCatalog?.getProfile("ejecucion") || TOOL_PROFILES_BASE.ejecucion;
    const profile = profileFor(
      /** @type {ToolProfile} */ (/** @type {unknown} */ (base)),
      readOnly,
    );
    const provider =
      /** @type {Record<string, string>} */ (PROVIDER_BY_ENGINE)[engine] ||
      engine;
    const childBase = sanitizeChildEnv(
      {
        ...environmentOf(provider, env),
        ...effortEnvironment(engine, agent.effort ?? null),
        SB_THREAD_ID: threadId,
      },
      profile,
      tokenFile,
      billingGranted,
      engine,
    );
    const mcp = buildMcpConfigForProfile({
      profile,
      env: { ...env, ...childBase },
      memberId: MCP_ACTOR[engine] || engine,
      sessionId: scopeId,
      sessionTokenFile: tokenFile,
    });
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...childBase, ...mcp.envOverrides };
    const geminiDir =
      engine === "agy" && !env.SB_AGY_ACP_ARGS
        ? acpGeminiDirFor(scopeId)
        : null;
    if (geminiDir) await mkdir(geminiDir, { recursive: true, mode: 0o700 });
    return {
      session: {
        id: scopeId,
        motor: engine,
        modelo: agent.model ?? null,
        esfuerzo: agent.effort ?? null,
      },
      cwd,
      env: childEnv,
      operatorEnv: env,
      mcpServers: mcp.mcpServers,
      toolProfile: profile,
      disableInheritedMcp: env.SB_PRESERVE_CODEX_MCP !== "1",
      verifiedBillingGrant: billingGranted,
      ...(geminiDir ? { geminiDir } : {}),
      /**
       * @param {string} bin
       * @param {string[]} args
       * @param {NodeJS.ProcessEnv} [processEnv]
       */
      spawn(bin, args, processEnv = childEnv) {
        const spec = sessionCommand({ bin, args }, scopeId, env);
        return spawn(spec.bin, spec.args, {
          cwd,
          env: processEnv,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    };
  }

  /**
   * Runs a setup command (dependency install) inside the thread's scope.
   * @param {{ threadId: string, cwd: string, argv: string[], onOutput: (chunk: string) => void }} input
   * @returns {Promise<number | null>}
   */
  function runSetup({ threadId, cwd, argv, onOutput }) {
    const scopeId = scopeIdOf(threadId);
    const [bin, ...args] = argv;
    const spec = sessionCommand(
      { bin: /** @type {string} */ (bin), args },
      `${scopeId}-setup`,
      env,
    );
    return new Promise((resolve) => {
      const child = spawn(spec.bin, spec.args, {
        cwd,
        env: {
          PATH: env.PATH,
          HOME: env.HOME,
          npm_config_update_notifier: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (d) => onOutput(String(d)));
      child.stderr?.on("data", (d) => onOutput(String(d)));
      child.once("error", (error) => {
        onOutput(String(error?.message || error));
        resolve(null);
      });
      child.once("close", (code) => resolve(code));
    });
  }

  /** @param {string} threadId */
  const stopScope = (threadId) => stopSessionScope(scopeIdOf(threadId), env);

  /**
   * @param {string} threadId
   * @param {string} token
   */
  async function saveToken(threadId, token) {
    const file = tokenFileOf(threadId);
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, token, { mode: 0o600 });
  }

  /** @param {string} threadId */
  async function dropToken(threadId) {
    const file = tokenFileOf(threadId);
    if (file) await rm(file, { force: true });
  }

  return { buildAgentContext, runSetup, stopScope, saveToken, dropToken };
}
