// Static data of the tool catalog: catalog states, base tool profiles and the
// skills the product ships. The logic that evaluates them is in
// tool-catalog.mjs.
/** @import { CatalogState, SkillProvenanceStage, SkillSpec, ToolProfiles } from "./tool-catalog-types.d.ts" */

/** @type {CatalogState[]} */
export const CATALOG_STATES = [
  "descubierta",
  "instalada",
  "configurada",
  "conectada",
  "probada",
  "permitida",
];

/** @type {Set<SkillProvenanceStage>} */
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

/** @type {ToolProfiles} */
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

/** @type {SkillSpec[]} */
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

/** @type {SkillSpec[]} */
export const LOCAL_SKILL_SPECS = [
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
