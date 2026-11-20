// Per-session runtime secrets: the agent token file, the effective tool profile
// and the skills materialized for the session.
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { TOOL_PROFILES_BASE, narrowChildProfile } from "../tool-catalog.mjs";
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "sessionTokenDir">} deps
 */
export function createSessionSecrets(config, state, deps) {
  const { toolCatalog } = config;
  const {
    materializedSkillCleanups,
    materializedSkillsBySession,
    sessionBillingGrants,
    sessionProfiles,
    sessionTokenFiles,
  } = state;
  const { sessionTokenDir } = deps;
  /**
   * @param {string} sessionId
   * @param {string} token
   */
  async function writeSessionTokenFile(sessionId, token) {
    const dir = sessionTokenDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${sessionId}.token`);
    await writeFile(file, String(token), { mode: 0o600 });
    sessionTokenFiles.set(sessionId, file);
    return file;
  }
  /** @param {string} sessionId */
  async function cleanupSessionRuntimeSecrets(sessionId) {
    const file = sessionTokenFiles.get(sessionId);
    sessionTokenFiles.delete(sessionId);
    sessionProfiles.delete(sessionId);
    sessionBillingGrants.delete(sessionId);
    materializedSkillsBySession.delete(sessionId);
    const cleanupSkills = materializedSkillCleanups.get(sessionId);
    materializedSkillCleanups.delete(sessionId);
    if (cleanupSkills) {
      await cleanupSkills().catch(() => {});
    }
    if (file) {
      await rm(file, { force: true }).catch(() => {});
    }
  }
  /** @param {LauncherSession} session */
  function resolveSessionEffectiveProfile(session) {
    const baseId = session.toolProfileId || "ejecucion";
    const baseCatalogProfile =
      toolCatalog?.getProfile(baseId) ||
      TOOL_PROFILES_BASE[baseId] ||
      TOOL_PROFILES_BASE.ejecucion;
    const override =
      sessionProfiles.get(session.id) || session.effectiveProfile || null;
    return override
      ? narrowChildProfile(baseCatalogProfile, override)
      : structuredClone(baseCatalogProfile);
  }
  return {
    writeSessionTokenFile,
    cleanupSessionRuntimeSecrets,
    resolveSessionEffectiveProfile,
  };
}
