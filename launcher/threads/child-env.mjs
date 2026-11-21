// The environment an agent CLI starts with: never the supervisor's tokens,
// external write secrets only when the profile allows them, and billed API
// keys only for a granted DeepSeek turn.
import os from "node:os";
import path from "node:path";
/** @import { ToolProfile } from "../tool-catalog-types.d.ts" */

/** Credential provider of each engine, when it differs from the engine id. */
/** @type {Partial<Record<string, string>>} */
export const PROVIDER_BY_ENGINE = { codex: "chatgpt", agy: "gemini" };

const EXTERNAL_WRITE_SECRETS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "RESEND_API_KEY",
  "SMTP_PASS",
  "STRIPE_API_KEY",
];

/**
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {ToolProfile} profile
 * @param {string | null} tokenFile
 * @param {boolean} billingGranted
 * @param {string} engine
 */
export function sanitizeChildEnv(
  baseEnv,
  profile,
  tokenFile,
  billingGranted,
  engine,
) {
  const next = { ...baseEnv };
  delete next.AGENTES_TOKEN_FILE;
  delete next.AGENTES_SECRETO;
  if (tokenFile) {
    next.SB_BRAIN_TOKEN_FILE = tokenFile;
    delete next.AGENTES_BRAIN_TOKEN_FILE;
  } else if (!profile?.allowedMcps?.includes("secondbrain")) {
    delete next.SB_BRAIN_TOKEN_FILE;
    delete next.AGENTES_BRAIN_TOKEN_FILE;
  }
  if (!profile?.allowExternalWriteSecrets)
    for (const key of EXTERNAL_WRITE_SECRETS) delete next[key];
  if (!(engine === "deepseek" && billingGranted)) {
    delete next.DEEPSEEK_API_KEY;
    delete next.ANTHROPIC_AUTH_TOKEN;
  }
  return next;
}

/**
 * Private Gemini settings folder of one ACP run.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} scopeId
 */
export function acpGeminiDir(env, scopeId) {
  const base =
    env.SB_LAUNCHER_DATA_DIR ?? path.join(os.tmpdir(), "sb-launcher");
  return path.join(base, "acp-runtime", scopeId, "gemini");
}
