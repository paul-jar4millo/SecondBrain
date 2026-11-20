import type { ProviderMcpServers } from "./lib/providers/shared.mjs";

export interface ToolProfile {
  id: string;
  name: string;
  description: string;
  allowedMcps: string[];
  allowedOperations: string[];
  allowedEffectCategories: string[];
  allowBilledApi: boolean;
  allowExternalWriteSecrets: boolean;
  canDelegateBeyondSelf: boolean;
}

export type ToolProfileLimits = Pick<
  ToolProfile,
  | "allowedMcps"
  | "allowedOperations"
  | "allowedEffectCategories"
  | "allowBilledApi"
  | "allowExternalWriteSecrets"
  | "canDelegateBeyondSelf"
>;

export type ToolProfiles = Record<
  "investigacion" | "ejecucion" | "coordinacion" | "integracion",
  ToolProfile
> &
  Partial<Record<string, ToolProfile>>;

export type ToolProfilePatch = Partial<
  Record<
    | "description"
    | "allowedMcps"
    | "allowedOperations"
    | "allowedEffectCategories",
    unknown
  >
>;

export type CatalogState =
  | "descubierta"
  | "instalada"
  | "configurada"
  | "conectada"
  | "probada"
  | "permitida";

export interface RuntimeProbe extends Partial<Record<CatalogState, boolean>> {
  installed?: boolean;
  connected?: boolean;
  version?: string;
  verifiedAt?: string;
  evidenceSource?: string;
  detail?: string;
  latencyMs?: number;
  billingAuthorized?: unknown;
}

export type RuntimeProbes = Partial<Record<string, RuntimeProbe>>;

export interface CatalogIdentity {
  motor: string;
  profileId: string;
  memberId: string | null;
  sessionId: string | null;
}

export interface EvidenceOptions {
  probe?: RuntimeProbe;
  nowIso: string;
  nowMs: number;
  freshnessMs: number;
  states: Record<CatalogState, boolean>;
  identity: CatalogIdentity;
  defaultDetail: string;
  fsConfigured?: boolean;
}

export interface McpConfigOptions {
  profile?: Pick<ToolProfile, "id" | "allowedMcps">;
  env?: NodeJS.ProcessEnv;
  memberId?: string | null;
  sessionId?: string | null;
  sessionTokenFile?: string | null;
  extraServers?: ProviderMcpServers | null;
}

export interface CatalogStoreOptions {
  dataDir?: string | null;
  env?: NodeJS.ProcessEnv;
  probes?: Record<string, unknown> | null;
  clock?: () => string;
  skillsDir?: string;
  freshnessTtlMs?: number;
  operatorBillingAuthorized?: boolean;
}

export interface HealthCheckOptions {
  targets?: string[];
  optIn?: boolean;
  fetchFn?: (
    input: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "ok" | "status">>;
  probeTimeoutMs?: number;
  cwd?: string | null;
  commandRunner?:
    | ((
        command: string,
        args: string[],
        options: { timeout: number },
      ) => unknown)
    | null;
  tokenFile?: string | null;
  brainUrl?: string | null;
}

export interface CatalogContext {
  motor?: string;
  profileId?: string;
  parentProfileId?: string | null;
  cwd?: string | null;
  runtimeProbes?: Record<string, unknown> | null;
  verifiedOperatorBillingGrant?: boolean;
}

export interface EvaluateCatalogOptions extends CatalogContext {
  memberId?: string | null;
  sessionId?: string | null;
  extraServers?: ProviderMcpServers | null;
}

export interface ResolveSkillsOptions extends CatalogContext {
  taskType?: string;
  skillIds?: unknown[] | null;
}

export interface SkillMaterializationOptions extends CatalogContext {
  skillIds?: unknown[] | null;
  geminiDir?: string | null;
  codexHome?: string | null;
  claudeConfigDir?: string | null;
}

export interface SkillSpec {
  id: string;
  file: string | null;
  requiredFiles: string[];
  trigger: string;
  version: string;
  implemented: boolean;
  requiredMcps: string[];
  requiredOperations: string[];
  phaseDependency?: string;
  pendingReason?: string;
}

export interface SkillInspection {
  exists: boolean;
  valid: boolean;
  sha256: string | null;
  rawBuffer: Buffer | null;
  missingFiles: string[];
  reason: string | null;
  rawText?: string;
  mainPath?: string;
  frontmatter?: Record<string, string>;
}

export type SkillProvenanceStage =
  | "sugerida"
  | "materializada"
  | "cargada_observada"
  | "ejecucion_reportada"
  | "verificada";

export interface SkillEvidence extends Record<string, unknown> {
  source?: string;
  verifiedAt?: string;
}

export interface SkillProvenanceInput {
  skillId: string;
  version?: string;
  sha256?: string | null;
  stage: SkillProvenanceStage;
  evidence?: SkillEvidence | null;
}

export interface SkillProvenance extends SkillProvenanceInput {
  version: string;
  sha256: string | null;
  evidence: SkillEvidence | null;
  verified: boolean;
  ts: string;
}

export interface SkillMaterialization {
  targetRoots?: string[];
  materialized: {
    id: string;
    version: string;
    sha256: string;
    sourcePath: string;
    targetPath: string;
  }[];
  provenance: SkillProvenance[];
  cleanup: () => Promise<void>;
}
