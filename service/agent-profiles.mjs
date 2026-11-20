// Tool profiles the service enforces on agent sessions when the launcher's
// catalog is unavailable, and the rules for narrowing a child's profile.
/** @import { ToolProfile } from "./types.d.ts" */

/** @type {{ ejecucion: ToolProfile } & Partial<Record<string, ToolProfile>>} */
export const SERVICE_TOOL_PROFILES = {
  investigacion: {
    id: "investigacion",
    allowedMcps: ["secondbrain", "web_search"],
    allowedOperations: [
      "vault.read",
      "vault.search",
      "file.read",
      "web.read",
      "user.ask",
    ],
    allowedEffectCategories: [],
    allowBilledApi: false,
    allowExternalWriteSecrets: false,
    canDelegateBeyondSelf: false,
  },
  ejecucion: {
    id: "ejecucion",
    allowedMcps: ["secondbrain", "git_workspace"],
    allowedOperations: [
      "vault.read",
      "vault.search",
      "vault.write",
      "file.read",
      "file.write",
      "shell.test",
      "git.local",
      "user.ask",
      "artifact.publish",
    ],
    allowedEffectCategories: ["destructive_change"],
    allowBilledApi: false,
    allowExternalWriteSecrets: false,
    canDelegateBeyondSelf: false,
  },
  coordinacion: {
    id: "coordinacion",
    allowedMcps: ["secondbrain", "git_workspace"],
    allowedOperations: [
      "vault.read",
      "vault.search",
      "vault.write",
      "team.coordinate",
      "file.read",
      "artifact.publish",
      "effect.prepare",
      "user.ask",
    ],
    allowedEffectCategories: [
      "external_message",
      "job_application",
      "destructive_change",
    ],
    allowBilledApi: false,
    allowExternalWriteSecrets: false,
    canDelegateBeyondSelf: false,
  },
  integracion: {
    id: "integracion",
    allowedMcps: ["secondbrain", "git_workspace", "web_search"],
    allowedOperations: [
      "vault.read",
      "vault.search",
      "vault.write",
      "file.read",
      "file.write",
      "shell.test",
      "git.local",
      "connector.probe",
      "effect.prepare",
      "user.ask",
      "artifact.publish",
    ],
    allowedEffectCategories: [
      "external_message",
      "job_application",
      "destructive_change",
    ],
    allowBilledApi: false,
    allowExternalWriteSecrets: false,
    canDelegateBeyondSelf: false,
  },
};
/** @type {Partial<Record<string, string>>} */
export const ENGINE_ACTOR = {
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
};
/**
 * @param {string[]} [a]
 * @param {string[]} [b]
 */
export const intersectList = (a = [], b = []) => {
  const allowed = new Set(b);
  return a.filter((item) => allowed.has(item));
};
/**
 * @param {ToolProfile | null} parent
 * @param {ToolProfile} child
 * @returns {ToolProfile}
 */
export const intersectProfileBounds = (parent, child) => {
  if (!parent) return structuredClone(child);
  return {
    id: child.id,
    allowedMcps: intersectList(child.allowedMcps, parent.allowedMcps),
    allowedOperations: intersectList(
      child.allowedOperations,
      parent.allowedOperations,
    ),
    allowedEffectCategories: intersectList(
      child.allowedEffectCategories,
      parent.allowedEffectCategories,
    ),
    allowBilledApi:
      Boolean(child.allowBilledApi) && Boolean(parent.allowBilledApi),
    allowExternalWriteSecrets: false,
    canDelegateBeyondSelf: false,
  };
};
