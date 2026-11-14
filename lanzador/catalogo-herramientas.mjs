// @ts-check
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./lib/hash.mjs";

export const CATALOG_STATES = [
  "descubierta",
  "instalada",
  "configurada",
  "conectada",
  "probada",
  "permitida",
];

export const SKILL_PROVENANCE_STAGES = new Set([
  "sugerida",
  "materializada",
  "cargada_observada",
  "ejecucion_reportada",
  "verificada",
]);

export const INHERITED_DESKTOP_CONNECTORS = [
  "blender",
  "obscura",
  "jobspy",
  "watch-skill",
  "claude.ai",
  "playwright-global",
];

export const TOOL_PROFILES_BASE = {
  investigacion: {
    id: "investigacion",
    name: "Investigación",
    description:
      "Lectura del vault, consulta web de solo lectura y verificación sin escrituras externas.",
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
    name: "Ejecución",
    description:
      "Edición en workspace del miembro, pruebas locales y notas atómicas por API.",
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
    name: "Coordinación",
    description:
      "Delegación acotada por manifiesto, seguimiento de entregas y preparación de efectos.",
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
    name: "Integración",
    description:
      "Pruebas de conectores en sandbox y preparación de operaciones aprobables.",
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

export const PRODUCT_SKILLS_SPEC = [
  {
    id: "personal-context",
    file: "personal-context/SKILL.md",
    requiredFiles: ["personal-context/SKILL.md"],
    trigger: "Inicio de encargo o decisión personal",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain"],
    requiredOperations: ["vault.read", "vault.search"],
  },
  {
    id: "research-and-verify",
    file: "research-and-verify/SKILL.md",
    requiredFiles: ["research-and-verify/SKILL.md"],
    trigger: "Investigación o comparación",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain", "web_search"],
    requiredOperations: ["vault.read", "web.read"],
  },
  {
    id: "team-coordinator",
    file: null,
    requiredFiles: [],
    trigger: "Encargo con varias tarjetas",
    version: "0.0.0-pendiente",
    implemented: false,
    phaseDependency: "la coordinación por manifiesto y workspaces",
    requiredMcps: ["secondbrain"],
    requiredOperations: ["team.coordinate"],
  },
  {
    id: "deliverable-verification",
    file: "deliverable-verification/SKILL.md",
    requiredFiles: ["deliverable-verification/SKILL.md"],
    trigger: "Antes de cerrar un encargo",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain"],
    requiredOperations: ["file.read"],
  },
  {
    id: "memory-curation",
    file: "memory-curation/SKILL.md",
    requiredFiles: ["memory-curation/SKILL.md"],
    trigger: "Hecho nuevo o corrección",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain"],
    requiredOperations: ["vault.read", "vault.write"],
  },
  {
    id: "opportunity-research",
    file: "opportunity-research/SKILL.md",
    requiredFiles: ["opportunity-research/SKILL.md"],
    trigger: "Búsqueda de oportunidades",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain", "web_search"],
    requiredOperations: ["vault.read", "web.read"],
  },
  {
    id: "document-production",
    file: "document-production/SKILL.md",
    requiredFiles: ["document-production/SKILL.md"],
    trigger: "Crear o revisar documentos",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain", "git_workspace"],
    requiredOperations: ["file.read", "file.write"],
  },
  {
    id: "integration-builder",
    file: "integration-builder/SKILL.md",
    requiredFiles: ["integration-builder/SKILL.md"],
    trigger: "Incorporar herramienta",
    version: "1.0.0",
    implemented: true,
    requiredMcps: ["secondbrain", "git_workspace"],
    requiredOperations: ["connector.probe", "shell.test"],
  },
  {
    id: "provider-handoff",
    file: null,
    requiredFiles: [],
    trigger: "Cambio de modelo o proveedor",
    version: "0.0.0-pendiente",
    implemented: false,
    phaseDependency: "el traspaso confirmado entre proveedores",
    requiredMcps: ["secondbrain"],
    requiredOperations: ["vault.read"],
  },
  {
    id: "routine-operator",
    file: null,
    requiredFiles: [],
    trigger: "Ejecución programada",
    version: "0.0.0-pendiente",
    implemented: false,
    phaseDependency: "el planificador de rutinas idempotente",
    requiredMcps: ["secondbrain"],
    requiredOperations: ["vault.read", "vault.write"],
  },
];

const LOCAL_SKILL_SPECS = [
  {
    id: "equipo-cuatro-fases",
    file: "equipo-cuatro-fases.md",
    requiredFiles: ["equipo-cuatro-fases.md"],
    trigger: "Coordinación multiagente",
    version: "local-md",
    implemented: true,
    requiredMcps: ["secondbrain"],
    requiredOperations: ["team.coordinate"],
  },
  {
    id: "resumen-matutino",
    file: "resumen-matutino.md",
    requiredFiles: ["resumen-matutino.md"],
    trigger: "Resumen diario programado",
    version: "local-md",
    implemented: true,
    requiredMcps: ["secondbrain"],
    requiredOperations: ["vault.read", "vault.write"],
  },
];

const MODULE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const MCP_ENTRY_PATH = fileURLToPath(
  new URL("../mcp/index.mjs", import.meta.url),
);
const DEFAULT_PROBE_FRESHNESS_MS = 15 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function intersect(baseList = [], overrideList = []) {
  const allowed = new Set(overrideList);
  return baseList.filter((item) => allowed.has(item));
}

function inspectFileNonEmptySync(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { exists: false, nonEmpty: false, reason: "ruta no configurada" };
  }
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      return {
        exists: false,
        nonEmpty: false,
        reason: "no es archivo regular",
      };
    }
    const content = readFileSync(filePath, "utf8").trim();
    if (!content) {
      return { exists: true, nonEmpty: false, reason: "archivo vacío" };
    }
    return { exists: true, nonEmpty: true, byteLength: st.size };
  } catch (err) {
    return {
      exists: false,
      nonEmpty: false,
      reason:
        err?.code === "ENOENT"
          ? "archivo inexistente"
          : err?.message || "ilegible",
    };
  }
}

function inspectDirSync(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return false;
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function parseSkillFrontmatter(rawText) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rawText);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) {
      meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return meta;
}

/** Ensures delegated child cards never exceed the coordinator's bounds. */
export function narrowChildProfile(parentProfile, childProfile) {
  if (!parentProfile) return structuredClone(childProfile);
  const child = structuredClone(childProfile);
  child.allowedMcps = intersect(child.allowedMcps, parentProfile.allowedMcps);
  child.allowedOperations = intersect(
    child.allowedOperations,
    parentProfile.allowedOperations,
  );
  child.allowedEffectCategories = intersect(
    child.allowedEffectCategories,
    parentProfile.allowedEffectCategories,
  );
  child.allowBilledApi =
    Boolean(child.allowBilledApi) && Boolean(parentProfile.allowBilledApi);
  child.allowExternalWriteSecrets = false;
  child.canDelegateBeyondSelf = false;
  return child;
}

function buildEvidenceMetadata({
  probe,
  nowIso,
  nowMs,
  freshnessMs,
  states,
  identity,
  defaultDetail,
  fsConfigured = false,
}) {
  const verifiedAt = probe?.verifiedAt || null;
  const verifiedMs = verifiedAt ? Date.parse(verifiedAt) : NaN;
  const hasTimestamp = Number.isFinite(verifiedMs);
  const fresh =
    hasTimestamp && freshnessMs > 0
      ? nowMs - verifiedMs <= freshnessMs
      : !states.probada
        ? null
        : hasTimestamp;
  const freshUntil =
    hasTimestamp && freshnessMs > 0
      ? new Date(verifiedMs + freshnessMs).toISOString()
      : null;
  let source = probe?.evidenceSource || "unverified";
  if (source === "unverified" && fsConfigured) {
    source = "fs_check";
  }
  const verificationStatus =
    states.probada && fresh === false
      ? "stale"
      : states.probada
        ? "verified"
        : states.conectada
          ? "connected_untested"
          : states.configurada
            ? "configured_unverified"
            : "unknown";
  return {
    source,
    verificationStatus,
    checkedAt: nowIso,
    verifiedAt,
    freshUntil,
    fresh,
    detail: probe?.detail || defaultDetail,
    observedLatencyMs: probe?.latencyMs ?? null,
    identity,
  };
}

function defaultEngineEntries(
  env = {},
  probes = {},
  nowIso,
  nowMs,
  freshnessMs,
  profile,
  identity,
  operatorBillingAuthorized = false,
) {
  const sdkPath = path.join(
    MODULE_ROOT,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  const claudeSdkInstalled = inspectFileNonEmptySync(sdkPath).exists;
  const claudeConfigured =
    Boolean(String(env.CLAUDE_CODE_OAUTH_TOKEN || "").trim()) ||
    inspectDirSync(env.AGENTES_CLAUDE_DIR);
  const codexHomeDir = env.CODEX_HOME || null;
  const codexConfigured = codexHomeDir ? inspectDirSync(codexHomeDir) : false;
  const agyConfigured = Boolean(
    env.GEMINI_HOME && inspectDirSync(env.GEMINI_HOME),
  );
  const deepseekConfigured = Boolean(String(env.DEEPSEEK_API_KEY || "").trim());

  const engineSpecs = [
    {
      id: "claude",
      version: probes.claude?.version || "2.x-sdk-0.3.326",
      origin: "anthropic-claude-code",
      license: "Propietaria / Suscripción",
      transports: ["agent-sdk", "headless-stream-json"],
      compatibleEngines: ["claude"],
      operations: ["chat.structured", "tool.native", "user.ask", "mcp.stdio"],
      scopes: ["workspace", "vault:room"],
      authRequired: true,
      costPolicy: "gratis_suscripcion",
      healthCheck: "oauth_or_session",
      probe: probes.claude,
      installed:
        probes.claude?.instalada ??
        probes.claude?.installed ??
        claudeSdkInstalled,
      configured: claudeConfigured,
      connected: Boolean(
        probes.claude?.conectada ?? probes.claude?.connected ?? false,
      ),
      tested: Boolean(probes.claude?.probada === true),
      unavailableWhenNotConnected:
        "Claude sin sesión autenticada verificada (no conectado)",
    },
    {
      id: "codex",
      version: probes.codex?.version || "app-server-stdio",
      origin: "openai-codex-cli",
      license: "Apache-2.0 / Suscripción",
      transports: ["app-server-stdio"],
      compatibleEngines: ["codex"],
      operations: [
        "chat.structured",
        "turn.steer",
        "turn.interrupt",
        "elicitation",
        "mcp.stdio",
      ],
      scopes: ["workspace-write", "vault:room"],
      authRequired: true,
      costPolicy: "gratis_suscripcion",
      healthCheck: "codex_home_and_app_server",
      probe: probes.codex,
      installed: probes.codex?.instalada ?? probes.codex?.installed ?? true,
      configured: codexConfigured,
      connected: Boolean(
        probes.codex?.conectada ?? probes.codex?.connected ?? false,
      ),
      tested: Boolean(probes.codex?.probada === true),
      unavailableWhenNotConnected:
        "Codex sin sesión verificada en runtime (configuración no acredita autenticación)",
    },
    {
      id: "agy",
      version: probes.agy?.version || "acp-1.5.10",
      origin: "antigravity-acp",
      license: "Propietaria / Suscripción",
      transports: ["acp-stdio"],
      compatibleEngines: ["agy"],
      operations: [
        "chat.structured",
        "session.resume",
        "session.cancel",
        "mcp.stdio",
      ],
      scopes: ["workspace", "vault:room"],
      authRequired: true,
      costPolicy: "gratis_suscripcion",
      healthCheck: "acp_initialize",
      probe: probes.agy,
      installed: probes.agy?.instalada ?? probes.agy?.installed ?? true,
      configured: agyConfigured,
      connected: Boolean(
        probes.agy?.conectada ?? probes.agy?.connected ?? false,
      ),
      tested: Boolean(probes.agy?.probada === true),
      unavailableWhenNotConnected:
        "Antigravity ACP sin verificación de sesión en vivo",
    },
    {
      id: "deepseek",
      version: probes.deepseek?.version || "anthropic-compat",
      origin: "deepseek-api",
      license: "API comercial",
      transports: ["agent-sdk"],
      compatibleEngines: ["deepseek"],
      operations: ["chat.structured", "mcp.stdio"],
      scopes: ["workspace", "vault:room"],
      authRequired: true,
      costPolicy: "api_facturada_bloqueada_r14",
      healthCheck: "billing_policy_r14_and_balance",
      probe: probes.deepseek,
      installed:
        probes.deepseek?.instalada ??
        probes.deepseek?.installed ??
        claudeSdkInstalled,
      configured: deepseekConfigured,
      connected: Boolean(
        probes.deepseek?.conectada ?? probes.deepseek?.connected ?? false,
      ),
      tested: Boolean(probes.deepseek?.probada === true),
      unavailableWhenNotConnected:
        "DeepSeek sin clave verificada ni balance comprobado",
    },
  ];

  return engineSpecs.map((spec) => {
    const billedBlocked =
      spec.costPolicy === "api_facturada_bloqueada_r14" &&
      !operatorBillingAuthorized;
    const states = {
      descubierta: spec.probe?.descubierta ?? true,
      instalada: Boolean(spec.installed),
      configurada: Boolean(spec.probe?.configurada ?? spec.configured),
      conectada: Boolean(spec.connected),
      probada: Boolean(spec.tested),
      permitida: !billedBlocked && (spec.probe?.permitida ?? true),
    };
    const evidence = buildEvidenceMetadata({
      probe: spec.probe,
      nowIso,
      nowMs,
      freshnessMs,
      states,
      identity,
      fsConfigured: states.configurada,
      defaultDetail: states.probada
        ? "Prueba funcional observada"
        : states.conectada
          ? "Conexión verificada; falta prueba funcional"
          : states.configurada
            ? "Configuración presente en disco; sin verificar conexión ni prueba"
            : "Sin verificación en este runtime (unknown/unverified)",
    });
    const isStale = states.probada && evidence.fresh === false;
    let causaNoDisponible = null;
    if (billedBlocked) {
      causaNoDisponible =
        "DeepSeek bloqueado por la política de gasto sin autorización humana u operador validada";
    } else if (!states.instalada) {
      causaNoDisponible = `Motor «${spec.id}» no instalado en el entorno`;
    } else if (!states.configurada || !states.conectada) {
      causaNoDisponible = spec.unavailableWhenNotConnected;
    } else if (!states.probada) {
      causaNoDisponible = `Motor «${spec.id}» conectado, pendiente de prueba funcional observada (probada=false)`;
    } else if (isStale) {
      causaNoDisponible = `Evidencia de salud vencida para motor «${spec.id}»`;
    } else if (!states.permitida) {
      causaNoDisponible = `Motor «${spec.id}» no permitido por la política activa`;
    }
    return {
      id: spec.id,
      kind: "engine",
      version: spec.version,
      identity,
      origin: spec.origin,
      license: spec.license,
      transports: spec.transports,
      compatibleEngines: spec.compatibleEngines,
      operations: spec.operations,
      scopes: spec.scopes,
      authRequired: spec.authRequired,
      costPolicy: spec.costPolicy,
      healthCheck: spec.healthCheck,
      lastCheckedAt: nowIso,
      states,
      evidence,
      usable: CATALOG_STATES.every((key) => states[key]) && !isStale,
      causaNoDisponible,
    };
  });
}

function defaultConnectorEntries(
  env = {},
  probes = {},
  nowIso,
  nowMs,
  freshnessMs,
  profile,
  identity,
  cwd = null,
) {
  const tokenFile = env.AGENTES_BRAIN_TOKEN_FILE || env.SB_BRAIN_TOKEN_FILE;
  const tokenCheck = inspectFileNonEmptySync(tokenFile);
  const brainUrl = env.SB_BRAIN_URL || env.AGENTES_BRAIN_URL;
  const hasBrainFileAndUrl = tokenCheck.nonEmpty && Boolean(brainUrl);
  const allowedSet = new Set(profile.allowedMcps || []);
  const workspaceDir = cwd || env.SB_WORKSPACE_DIR || null;
  const workspaceReady = workspaceDir ? inspectDirSync(workspaceDir) : false;

  const defs = [
    {
      id: "secondbrain",
      kind: "mcp",
      version: probes.secondbrain?.version || "0.2.0",
      origin: "secondbrain-monorepo",
      license: "Privada",
      transports: ["stdio"],
      compatibleEngines: ["claude", "codex", "agy", "deepseek"],
      operations: [
        "brain_context",
        "brain_list",
        "brain_read",
        "brain_search",
        "brain_write",
        "brain_finance",
        "equipo_*",
        "files_*",
        "usuario_preguntar",
        "usuario_consultar_respuesta",
        "usuario_esperar_respuesta",
      ],
      scopes: ["vault:room", "shared:files"],
      authRequired: true,
      costPolicy: "gratis_suscripcion",
      healthCheck: "token_file_and_service_health_opt_in",
      probe: probes.secondbrain,
      installed: true,
      configurada: hasBrainFileAndUrl,
      conectada: Boolean(
        probes.secondbrain?.conectada ?? probes.secondbrain?.connected ?? false,
      ),
      probada: Boolean(probes.secondbrain?.probada === true),
      permitida: allowedSet.has("secondbrain"),
      executionMode: "mcp_stdio",
      missingConfigReason: tokenFile
        ? !tokenCheck.nonEmpty
          ? `Archivo de token SecondBrain inválido (${tokenCheck.reason})`
          : "Falta URL de servicio SB_BRAIN_URL para SecondBrain"
        : "Archivo de token MCP SecondBrain no configurado",
      missingConnectReason:
        "Conector «secondbrain» configurado en disco pero sin verificación de conexión HTTP/MCP",
    },
    {
      id: "git_workspace",
      kind: "tool",
      version: probes.git_workspace?.version || "local-git",
      origin: "lanzador-workspace",
      license: "Interna",
      transports: ["local-fs"],
      compatibleEngines: ["claude", "codex", "agy", "deepseek"],
      operations: ["file.read", "file.write", "git.local", "shell.test"],
      scopes: ["workspace-only"],
      authRequired: false,
      costPolicy: "gratis_suscripcion",
      healthCheck: "workspace_directory_and_git_probe",
      probe: probes.git_workspace,
      installed: true,
      configurada: workspaceReady,
      conectada: Boolean(
        probes.git_workspace?.conectada ??
        probes.git_workspace?.connected ??
        false,
      ),
      probada: Boolean(probes.git_workspace?.probada === true),
      permitida: allowedSet.has("git_workspace"),
      executionMode: "local_workspace",
      missingConfigReason: "Directorio de workspace aislado no verificado",
      missingConnectReason:
        "Workspace local sin comprobación de acceso ni prueba funcional",
    },
    {
      id: "web_search",
      kind: "mcp",
      version: probes.web_search?.version || "1.0.0",
      origin: "search-connector",
      license: "Externa / Mixta",
      transports: ["stdio", "http"],
      compatibleEngines: ["claude", "codex", "agy"],
      operations: ["web.read", "web.search"],
      scopes: ["read-only"],
      authRequired: false,
      costPolicy: "gratis_suscripcion",
      healthCheck: "search_endpoint_or_mcp",
      probe: probes.web_search,
      installed:
        probes.web_search?.instalada ?? probes.web_search?.installed ?? false,
      configurada: probes.web_search?.configurada ?? false,
      conectada:
        probes.web_search?.conectada ?? probes.web_search?.connected ?? false,
      probada: probes.web_search?.probada ?? false,
      permitida: allowedSet.has("web_search"),
      executionMode: "manual_no_conectado",
      missingConfigReason: "MCP requerido «web_search» no conectado",
      missingConnectReason: "MCP requerido «web_search» no conectado",
    },
    {
      id: "external_dispatch",
      kind: "tool",
      version: probes.external_dispatch?.version || "0.2.0",
      origin: "service-effects-executor",
      license: "Privada",
      transports: ["service-http"],
      compatibleEngines: ["claude", "codex", "agy", "deepseek"],
      operations: ["effect.prepare", "effect.execute_with_approval"],
      scopes: ["approval-required"],
      authRequired: true,
      costPolicy: "gratis_suscripcion",
      healthCheck: "effects_executor_policy_r07",
      probe: probes.external_dispatch,
      installed: true,
      configurada: Boolean(probes.external_dispatch?.configurada ?? false),
      conectada: Boolean(
        probes.external_dispatch?.conectada ??
        probes.external_dispatch?.connected ??
        false,
      ),
      probada: Boolean(probes.external_dispatch?.probada === true),
      permitida:
        Array.isArray(profile.allowedEffectCategories) &&
        profile.allowedEffectCategories.length > 0,
      executionMode:
        probes.external_dispatch?.conectada && probes.external_dispatch?.probada
          ? "conector"
          : "manual_sin_conector",
      missingConfigReason:
        "Sin conector externo conectado: operaciones externas quedan en preparación manual (manual_sin_conector)",
      missingConnectReason:
        "Sin conector externo probado: disponible solo en modo preparación manual",
    },
  ];

  return defs.map((d) => {
    const states = {
      descubierta: d.probe?.descubierta ?? true,
      instalada: Boolean(d.probe?.instalada ?? d.installed),
      configurada: Boolean(d.probe?.configurada ?? d.configurada),
      conectada: Boolean(d.conectada),
      probada: Boolean(d.probada),
      permitida: Boolean(d.probe?.permitida ?? d.permitida),
    };
    const evidence = buildEvidenceMetadata({
      probe: d.probe,
      nowIso,
      nowMs,
      freshnessMs,
      states,
      identity,
      fsConfigured: states.configurada,
      defaultDetail: states.probada
        ? "Conector probado y verificado"
        : states.conectada
          ? "Conector conectado sin prueba funcional verificada"
          : states.configurada
            ? "Configuración presente; conexión no comprobada"
            : "Sin configuración o sin verificación de salud",
    });
    const isStale = states.probada && evidence.fresh === false;
    let causaNoDisponible = null;
    if (!states.instalada) {
      causaNoDisponible = `Conector «${d.id}» no instalado`;
    } else if (!states.configurada) {
      causaNoDisponible = d.missingConfigReason;
    } else if (!states.conectada) {
      causaNoDisponible = d.missingConnectReason;
    } else if (!states.probada) {
      causaNoDisponible = `Conector «${d.id}» sin verificación funcional observada (probada=false)`;
    } else if (isStale) {
      causaNoDisponible = `Evidencia de salud vencida para «${d.id}»`;
    } else if (!states.permitida) {
      causaNoDisponible =
        d.id === "external_dispatch"
          ? "El perfil activo no permite preparar efectos externos"
          : `No permitido en el perfil «${profile.id}»`;
    }
    return {
      id: d.id,
      kind: d.kind,
      version: d.version,
      identity,
      origin: d.origin,
      license: d.license,
      transports: d.transports,
      compatibleEngines: d.compatibleEngines,
      operations: d.operations,
      scopes: d.scopes,
      authRequired: d.authRequired,
      costPolicy: d.costPolicy,
      healthCheck: d.healthCheck,
      executionMode: d.executionMode,
      lastCheckedAt: nowIso,
      states,
      evidence,
      usable: CATALOG_STATES.every((k) => states[k]) && !isStale,
      causaNoDisponible,
    };
  });
}

/**
 * Generates an explicit isolated MCP server configuration strictly matching the active ToolProfile.
 * Inherited desktop connectors (blender, obscura, jobspy, claude.ai, etc.) are always disabled.
 */
export function buildMcpConfigForProfile(
  {
    profile = TOOL_PROFILES_BASE.ejecucion,
    env = /** @type {Record<string, string | undefined>} */ ({}),
    memberId = null,
    sessionId = null,
    sessionTokenFile = null,
    extraServers = {},
  } = /** @type {any} */ ({}),
) {
  const allowedMcps = new Set(profile?.allowedMcps || []);
  const mcpServers = {};

  const tokenFile =
    sessionTokenFile || env.SB_BRAIN_TOKEN_FILE || env.AGENTES_BRAIN_TOKEN_FILE;
  if (allowedMcps.has("secondbrain") && tokenFile) {
    const brainEnv = {
      SB_BRAIN_TOKEN_FILE: tokenFile,
      SB_BRAIN_URL: env.SB_BRAIN_URL || env.AGENTES_BRAIN_URL,
      SB_AGENTE: memberId || env.SB_AGENTE,
      SB_SESSION_ID: sessionId || env.SB_SESSION_ID,
    };
    mcpServers.secondbrain = {
      command: process.execPath,
      args: [MCP_ENTRY_PATH],
      env: Object.fromEntries(
        Object.entries(brainEnv).filter(([, v]) => Boolean(v)),
      ),
    };
  }

  for (const [name, server] of Object.entries(extraServers || {})) {
    if (!allowedMcps.has(name)) continue;
    if (server && typeof server === "object") {
      mcpServers[name] = structuredClone(server);
    }
  }

  return {
    profileId: profile.id,
    mcpServers,
    disabledDesktopConnectors: INHERITED_DESKTOP_CONNECTORS,
    envOverrides: {
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
  };
}

export async function createToolCatalogStore(
  {
    dataDir = null,
    env = process.env,
    probes = {},
    clock = () => new Date().toISOString(),
    skillsDir = path.join(MODULE_ROOT, "skills"),
    freshnessTtlMs = DEFAULT_PROBE_FRESHNESS_MS,
    operatorBillingAuthorized = false,
  } = /** @type {any} */ ({}),
) {
  const profiles = structuredClone(TOOL_PROFILES_BASE);
  const observedProbes = new Map();
  for (const [k, v] of Object.entries(probes || {})) {
    if (k === "billingAuthorized") continue;
    if (v && typeof v === "object") observedProbes.set(k, structuredClone(v));
  }
  const profileFile = dataDir ? path.join(dataDir, "tool-profiles.json") : null;
  if (profileFile) {
    try {
      const saved = JSON.parse(await readFile(profileFile, "utf8"));
      if (saved && typeof saved === "object") {
        for (const [id, data] of Object.entries(saved)) {
          if (profiles[id] && data && typeof data === "object") {
            profiles[id] = { ...profiles[id], ...data, id };
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function saveProfiles() {
    if (!profileFile) return;
    await mkdir(path.dirname(profileFile), { recursive: true, mode: 0o700 });
    const tmp = `${profileFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(profiles, null, 2), { mode: 0o600 });
    await rename(tmp, profileFile);
  }

  function resolveProfile(profileId = "ejecucion", parentProfileId = null) {
    const base = profiles[profileId];
    if (!base) {
      throw new Error(`Perfil de herramientas desconocido: ${profileId}`);
    }
    if (parentProfileId) {
      const parent = profiles[parentProfileId];
      if (!parent) {
        throw new Error(
          `Perfil de coordinadora desconocido: ${parentProfileId}`,
        );
      }
      return narrowChildProfile(parent, base);
    }
    return structuredClone(base);
  }

  async function inspectSkillSpec(spec) {
    if (spec.implemented === false || !spec.file) {
      return {
        exists: false,
        valid: false,
        sha256: null,
        rawBuffer: null,
        missingFiles: [],
        reason:
          spec.pendingReason ||
          (spec.phaseDependency
            ? `Skill pendiente de ${spec.phaseDependency}`
            : "Skill sin archivo implementado"),
      };
    }
    const mainPath = path.join(skillsDir, spec.file);
    let rawBuffer;
    try {
      const st = await stat(mainPath);
      if (!st.isFile()) {
        return {
          exists: false,
          valid: false,
          sha256: null,
          rawBuffer: null,
          missingFiles: [spec.file],
          reason: `La ruta de skill "${spec.file}" no es un archivo regular`,
        };
      }
      rawBuffer = await readFile(mainPath);
    } catch {
      return {
        exists: false,
        valid: false,
        sha256: null,
        rawBuffer: null,
        missingFiles: [spec.file],
        reason: `Falta el archivo de skill "${spec.file}" en disco`,
      };
    }
    const sha256 = sha256Hex(rawBuffer);
    const rawText = rawBuffer.toString("utf8");
    const fm = parseSkillFrontmatter(rawText);
    if (!fm || !fm.name || !fm.description || fm.name !== spec.id) {
      return {
        exists: true,
        valid: false,
        sha256,
        rawBuffer,
        missingFiles: [],
        reason: `Frontmatter YAML inválido o inconsistente en "${spec.file}"`,
      };
    }
    const missingFiles = [];
    for (const rel of spec.requiredFiles || []) {
      const target = path.join(skillsDir, rel);
      const ok = await stat(target)
        .then((s) => s.isFile())
        .catch(() => false);
      if (!ok) missingFiles.push(rel);
    }
    if (missingFiles.length > 0) {
      return {
        exists: true,
        valid: false,
        sha256,
        rawBuffer,
        missingFiles,
        reason: `Faltan anexos requeridos para la skill: ${missingFiles.join(", ")}`,
      };
    }
    return {
      exists: true,
      valid: true,
      sha256,
      rawBuffer,
      rawText,
      mainPath,
      frontmatter: fm,
      missingFiles: [],
      reason: null,
    };
  }

  return {
    getProfiles() {
      return structuredClone(Object.values(profiles));
    },

    getProfile(profileId = "ejecucion", parentProfileId = null) {
      return resolveProfile(profileId, parentProfileId);
    },

    async updateProfile(profileId, patch) {
      if (!profiles[profileId]) {
        throw new Error(`Perfil de herramientas desconocido: ${profileId}`);
      }
      const next = { ...profiles[profileId] };
      if (Array.isArray(patch.allowedMcps)) {
        next.allowedMcps = [...new Set(patch.allowedMcps.map(String))];
      }
      if (Array.isArray(patch.allowedOperations)) {
        next.allowedOperations = [
          ...new Set(patch.allowedOperations.map(String)),
        ];
      }
      if (Array.isArray(patch.allowedEffectCategories)) {
        next.allowedEffectCategories = [
          ...new Set(patch.allowedEffectCategories.map(String)),
        ];
      }
      if (typeof patch.description === "string") {
        next.description = patch.description.slice(0, 400);
      }
      // Spending and external-write policies: profile updates never grant billed APIs or external write secrets unilaterally.
      next.allowBilledApi = false;
      next.allowExternalWriteSecrets = false;
      next.canDelegateBeyondSelf = false;
      profiles[profileId] = next;
      await saveProfiles();
      return structuredClone(next);
    },

    recordObservedRuntimeProbe(targetId, probeData) {
      if (!targetId || typeof probeData !== "object" || !probeData) return null;
      const nowIso = clock();
      const entry = {
        ...structuredClone(probeData),
        verifiedAt: probeData.verifiedAt || nowIso,
        evidenceSource: probeData.evidenceSource || "observed_runtime",
      };
      delete entry.billingAuthorized;
      observedProbes.set(String(targetId), entry);
      return structuredClone(entry);
    },

    async runHealthChecks(
      {
        targets = ["secondbrain", "git_workspace"],
        optIn = false,
        fetchFn = fetch,
        probeTimeoutMs = 3000,
        cwd = null,
        commandRunner = null,
        tokenFile: overrideTokenFile = null,
        brainUrl: overrideBrainUrl = null,
      } = /** @type {any} */ ({}),
    ) {
      if (!optIn) {
        return {
          executed: false,
          reason:
            "Health checks remotos o de runtime son opt-in; no se ejecutan por defecto.",
        };
      }
      const results = {};
      const nowIso = clock();
      const targetSet = new Set(targets);

      if (targetSet.has("secondbrain")) {
        const started = Date.now();
        const tokenFile =
          overrideTokenFile ||
          env.AGENTES_BRAIN_TOKEN_FILE ||
          env.SB_BRAIN_TOKEN_FILE;
        const brainUrl = String(
          overrideBrainUrl ||
            env.SB_BRAIN_URL ||
            env.AGENTES_BRAIN_URL ||
            env.SB_SERVICE_URL ||
            "",
        ).replace(/\/$/, "");
        const tokenCheck = inspectFileNonEmptySync(tokenFile);
        if (!tokenCheck.nonEmpty || !brainUrl) {
          const entry = {
            instalada: true,
            configurada: false,
            conectada: false,
            probada: false,
            verifiedAt: nowIso,
            evidenceSource: "opt_in_healthcheck",
            detail: !tokenCheck.nonEmpty
              ? `Token SecondBrain inválido (${tokenCheck.reason})`
              : "Falta SB_BRAIN_URL",
          };
          observedProbes.set("secondbrain", entry);
          results.secondbrain = entry;
        } else {
          try {
            const token = readFileSync(tokenFile, "utf8").trim();
            const healthRes = await fetchFn(`${brainUrl}/health`, {
              signal: AbortSignal.timeout(probeTimeoutMs),
            });
            const filesRes = await fetchFn(`${brainUrl}/vault/files`, {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(probeTimeoutMs),
            });
            const conectada = Boolean(healthRes.ok);
            const probada = Boolean(healthRes.ok && filesRes.ok);
            const entry = {
              instalada: true,
              configurada: true,
              conectada,
              probada,
              verifiedAt: nowIso,
              latencyMs: Date.now() - started,
              evidenceSource: "opt_in_healthcheck",
              detail: probada
                ? "Health check GET /health y GET /vault/files autenticados OK"
                : `HTTP health=${healthRes.status} files=${filesRes.status}`,
            };
            observedProbes.set("secondbrain", entry);
            results.secondbrain = entry;
          } catch (err) {
            const entry = {
              instalada: true,
              configurada: true,
              conectada: false,
              probada: false,
              verifiedAt: nowIso,
              latencyMs: Date.now() - started,
              evidenceSource: "opt_in_healthcheck",
              detail: `Fallo health check SecondBrain: ${err?.message || err}`,
            };
            observedProbes.set("secondbrain", entry);
            results.secondbrain = entry;
          }
        }
      }

      if (targetSet.has("git_workspace")) {
        const wsDir = cwd || env.SB_WORKSPACE_DIR || null;
        if (!wsDir || !inspectDirSync(wsDir)) {
          const entry = {
            instalada: true,
            configurada: false,
            conectada: false,
            probada: false,
            verifiedAt: nowIso,
            evidenceSource: "opt_in_healthcheck",
            detail: "Directorio de workspace inexistente",
          };
          observedProbes.set("git_workspace", entry);
          results.git_workspace = entry;
        } else {
          try {
            let gitOk = true;
            if (typeof commandRunner === "function") {
              await commandRunner(
                "git",
                ["-C", wsDir, "rev-parse", "--git-dir"],
                {
                  timeout: probeTimeoutMs,
                },
              );
            }
            const entry = {
              instalada: true,
              configurada: true,
              conectada: gitOk,
              probada: typeof commandRunner === "function" ? gitOk : false,
              verifiedAt: nowIso,
              evidenceSource: "opt_in_healthcheck",
              detail:
                typeof commandRunner === "function"
                  ? "Workspace verificado en disco y git accesible"
                  : "Directorio presente; falta prueba de ejecución git",
            };
            observedProbes.set("git_workspace", entry);
            results.git_workspace = entry;
          } catch (err) {
            const entry = {
              instalada: true,
              configurada: true,
              conectada: false,
              probada: false,
              verifiedAt: nowIso,
              evidenceSource: "opt_in_healthcheck",
              detail: `Error verificando workspace: ${err?.message || err}`,
            };
            observedProbes.set("git_workspace", entry);
            results.git_workspace = entry;
          }
        }
      }

      return { executed: true, checkedAt: nowIso, results };
    },

    evaluateCatalog(
      {
        motor = "codex",
        profileId = "ejecucion",
        parentProfileId = null,
        memberId = null,
        sessionId = null,
        cwd = null,
        extraServers = {},
        runtimeProbes = {},
        verifiedOperatorBillingGrant = false,
      } = /** @type {any} */ ({}),
    ) {
      const profile = resolveProfile(profileId, parentProfileId);
      // Merge stored verified probes + explicit caller runtimeProbes WITHOUT accepting untrusted billingAuthorized.
      const sanitizedRuntimeProbes = {};
      for (const [k, v] of Object.entries(runtimeProbes || {})) {
        if (k === "billingAuthorized") continue;
        if (v && typeof v === "object") sanitizedRuntimeProbes[k] = v;
      }
      const mergedProbes = {};
      for (const [k, v] of observedProbes.entries()) mergedProbes[k] = v;
      Object.assign(mergedProbes, sanitizedRuntimeProbes);

      const nowIso = clock();
      const nowMs = Date.parse(nowIso) || Date.now();
      const identity = {
        motor,
        profileId: profile.id,
        memberId,
        sessionId,
      };
      const billingAllowed =
        Boolean(verifiedOperatorBillingGrant) ||
        Boolean(
          operatorBillingAuthorized && env.SB_ALLOW_BILLED_DEEPSEEK === "1",
        );
      const engines = defaultEngineEntries(
        env,
        mergedProbes,
        nowIso,
        nowMs,
        freshnessTtlMs,
        profile,
        identity,
        billingAllowed,
      );
      const connectors = defaultConnectorEntries(
        env,
        mergedProbes,
        nowIso,
        nowMs,
        freshnessTtlMs,
        profile,
        identity,
        cwd,
      );
      const mcpConfig = buildMcpConfigForProfile({
        profile,
        env,
        memberId,
        sessionId,
        extraServers,
      });
      return {
        identity,
        profile,
        mcpConfig,
        engines,
        connectors,
        items: [...engines, ...connectors],
        checkedAt: nowIso,
      };
    },

    async resolveSkillsForTask(
      {
        motor = "codex",
        profileId = "ejecucion",
        parentProfileId = null,
        taskType = "",
        skillIds = null,
        cwd = null,
        runtimeProbes = {},
        verifiedOperatorBillingGrant = false,
      } = /** @type {any} */ ({}),
    ) {
      const evaluation = this.evaluateCatalog({
        motor,
        profileId,
        parentProfileId,
        cwd,
        runtimeProbes,
        verifiedOperatorBillingGrant,
      });
      const connectorById = new Map(
        evaluation.connectors.map((c) => [c.id, c]),
      );
      const opsSet = new Set(evaluation.profile.allowedOperations || []);

      const allSpecs = [...PRODUCT_SKILLS_SPEC, ...LOCAL_SKILL_SPECS];
      let selectedSpecs;
      if (Array.isArray(skillIds) && skillIds.length > 0) {
        const wanted = new Set(skillIds.map(String));
        selectedSpecs = allSpecs.filter((s) => wanted.has(s.id));
        const missingSpecIds = [...wanted].filter(
          (id) => !selectedSpecs.some((s) => s.id === id),
        );
        for (const unknownId of missingSpecIds) {
          selectedSpecs.push({
            id: unknownId,
            file: `${unknownId}/SKILL.md`,
            requiredFiles: [`${unknownId}/SKILL.md`],
            trigger: "Desconocida",
            version: "0.0.0",
            implemented: true,
            requiredMcps: ["secondbrain"],
            requiredOperations: ["vault.read"],
          });
        }
      } else if (taskType && String(taskType).trim()) {
        const needle = String(taskType).trim().toLowerCase();
        selectedSpecs = allSpecs.filter(
          (s) =>
            s.id.toLowerCase().includes(needle) ||
            s.trigger.toLowerCase().includes(needle),
        );
      } else {
        selectedSpecs = allSpecs;
      }

      const skills = await Promise.all(
        selectedSpecs.map(async (spec) => {
          const inspected = await inspectSkillSpec(spec);
          const reasons = [];
          const missingMcps = [];
          if (spec.implemented === false) {
            reasons.push(inspected.reason);
          } else if (!inspected.valid) {
            reasons.push(inspected.reason);
          }
          for (const reqMcp of spec.requiredMcps || []) {
            const entry = connectorById.get(reqMcp);
            if (!entry || !entry.usable) {
              missingMcps.push(reqMcp);
              reasons.push(
                entry?.causaNoDisponible ||
                  `MCP requerido «${reqMcp}» no conectado o no probado`,
              );
            }
          }
          const missingOps = (spec.requiredOperations || []).filter(
            (op) => !opsSet.has(op),
          );
          if (missingOps.length > 0) {
            reasons.push(
              `El perfil «${evaluation.profile.id}» no habilita: ${missingOps.join(", ")}`,
            );
          }

          const usable =
            spec.implemented !== false &&
            inspected.valid &&
            missingMcps.length === 0 &&
            missingOps.length === 0;
          const estado =
            spec.implemented === false
              ? "pendiente_fase"
              : usable
                ? "utilizable"
                : "no_utilizable";
          return {
            id: spec.id,
            trigger: spec.trigger,
            version: spec.version,
            file: spec.file,
            sha256: inspected.sha256,
            fileExists: inspected.exists,
            missingFiles: inspected.missingFiles,
            requiredMcps: spec.requiredMcps,
            requiredOperations: spec.requiredOperations,
            phaseDependency: spec.phaseDependency || null,
            usable,
            estado,
            causaNoDisponible: usable ? null : reasons.join("; "),
            missingMcps,
            missingOperations: missingOps,
            provenance: {
              skillId: spec.id,
              version: spec.version,
              sha256: inspected.sha256,
              stage: "sugerida",
              verified: false,
            },
          };
        }),
      );

      return {
        identity: evaluation.identity,
        profile: evaluation.profile,
        skills,
      };
    },

    async materializeSkillsForSession(
      {
        motor = "agy",
        profileId = "ejecucion",
        parentProfileId = null,
        skillIds = [],
        cwd = null,
        geminiDir = null,
        codexHome = null,
        claudeConfigDir = null,
        runtimeProbes = {},
        verifiedOperatorBillingGrant = false,
      } = /** @type {any} */ ({}),
    ) {
      if (!Array.isArray(skillIds) || skillIds.length === 0) {
        return {
          targetRoots: [],
          materialized: [],
          provenance: [],
          cleanup: async () => {},
        };
      }
      const resolution = await this.resolveSkillsForTask({
        motor,
        profileId,
        parentProfileId,
        skillIds,
        cwd,
        runtimeProbes,
        verifiedOperatorBillingGrant,
      });
      const materialized = [];
      const provenance = [];
      const createdDirs = [];
      for (const skill of resolution.skills) {
        if (!skill.usable || !skill.file || !skill.sha256) {
          throw new Error(
            `Skill "${skill.id}" no utilizable para sesión ${motor}: ${skill.causaNoDisponible || skill.estado}`,
          );
        }
        const sourcePath = path.join(skillsDir, skill.file);
        const bytes = await readFile(sourcePath);
        const actualSha = sha256Hex(bytes);
        if (actualSha !== skill.sha256) {
          throw new Error(
            `Hash de skill "${skill.id}" cambió durante la materialización`,
          );
        }
        let targetSkillDir;
        if (motor === "agy") {
          const base = geminiDir || (cwd ? path.join(cwd, ".agents") : null);
          if (!base) {
            throw new Error(
              "Falta directorio aislado para materializar skill ACP",
            );
          }
          targetSkillDir = path.join(base, "skills", skill.id);
        } else if (motor === "codex") {
          const base = cwd ? path.join(cwd, ".agents") : codexHome;
          if (!base) {
            throw new Error(
              "Falta workspace o CODEX_HOME para materializar skill Codex",
            );
          }
          targetSkillDir = path.join(base, "skills", skill.id);
        } else {
          const base =
            claudeConfigDir || (cwd ? path.join(cwd, ".claude") : null);
          if (!base) {
            throw new Error(
              "Falta workspace o CLAUDE_CONFIG_DIR para materializar skill",
            );
          }
          targetSkillDir = path.join(base, "skills", skill.id);
        }
        await mkdir(targetSkillDir, { recursive: true, mode: 0o700 });
        createdDirs.push(targetSkillDir);
        const targetFile = path.join(targetSkillDir, "SKILL.md");
        await writeFile(targetFile, bytes, { mode: 0o600 });
        materialized.push({
          id: skill.id,
          version: skill.version,
          sha256: actualSha,
          sourcePath,
          targetPath: targetFile,
        });
        provenance.push(
          this.recordSkillProvenance([], {
            skillId: skill.id,
            version: skill.version,
            sha256: actualSha,
            stage: "materializada",
            evidence: {
              source: "fs_materialized_verified",
              targetPath: targetFile,
              verifiedAt: clock(),
            },
          })[0],
        );
      }
      return {
        materialized,
        provenance,
        cleanup: async () => {
          await Promise.allSettled(
            createdDirs.map((d) => rm(d, { recursive: true, force: true })),
          );
        },
      };
    },

    recordSkillProvenance(history = [], entry) {
      if (
        !entry ||
        !entry.skillId ||
        !SKILL_PROVENANCE_STAGES.has(entry.stage)
      ) {
        throw new Error(
          "Procedencia de skill inválida (usa: sugerida, materializada, cargada_observada, ejecucion_reportada, verificada).",
        );
      }
      const sha256 = String(entry.sha256 || "");
      const requiresProof = [
        "materializada",
        "cargada_observada",
        "verificada",
      ].includes(entry.stage);
      if (requiresProof) {
        if (!SHA256_RE.test(sha256)) {
          throw new Error(
            `Procedencia "${entry.stage}" requiere sha256 real de 64 caracteres hexadecimales.`,
          );
        }
        if (
          !entry.evidence ||
          typeof entry.evidence !== "object" ||
          !entry.evidence.source ||
          !entry.evidence.verifiedAt
        ) {
          throw new Error(
            `Procedencia "${entry.stage}" requiere evidencia observada (source y verifiedAt).`,
          );
        }
      }
      return [
        ...history,
        {
          skillId: String(entry.skillId),
          version: String(entry.version || "1.0.0"),
          sha256: sha256 || null,
          stage: entry.stage,
          verified:
            entry.stage === "verificada" ||
            entry.stage === "cargada_observada" ||
            entry.stage === "materializada",
          evidence: entry.evidence ? structuredClone(entry.evidence) : null,
          ts: clock(),
        },
      ];
    },
  };
}
