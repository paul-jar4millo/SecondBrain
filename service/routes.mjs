import { z } from "zod";
const object = z.object({}).passthrough();
const entity = z
  .object({ id: z.string(), kind: z.string(), title: z.string() })
  .passthrough();
/** @type {Partial<Record<string, z.ZodType>>} */
const schemas = {
  "POST /auth/setup": z
    .object({
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .passthrough(),
  "POST /auth/login": z
    .object({
      username: z.string().optional(),
      password: z.string().optional(),
      code: z.string().optional(),
    })
    .passthrough(),
  "POST /auth/totp/enable": z.object({ code: z.string() }).passthrough(),
  "POST /sala/tablero": z
    .object({
      id: z.string(),
      guardar: z.boolean(),
      espacio: z.string().optional(),
    })
    .passthrough(),
  "POST /sala/encargos": z
    .object({
      id: z.string(),
      mode: z.string(),
      instruction: z.string().optional(),
      project: z.string().optional(),
    })
    .passthrough(),
  "POST /sala/agentes/borrar": z.object({ id: z.string() }).passthrough(),
  "POST /finance/ops": z
    .object({ op: z.string(), requestId: z.string().max(100).optional() })
    .passthrough(),
  "POST /mundo/briefs": z
    .object({ title: z.string(), brief: z.string(), slug: z.string() })
    .passthrough(),
  "POST /mundo/agents": z
    .object({ id: z.string(), enabled: z.boolean(), notes: z.string() })
    .passthrough(),
  "POST /mundo/tasks": z
    .object({
      agentId: z.string(),
      instruction: z.string(),
      videoId: z.string().nullable().optional(),
    })
    .passthrough(),
  "POST /mundo/tasks/status": z
    .object({ id: z.string(), status: z.string() })
    .passthrough(),
  "POST /mutations": z
    .object({
      mutationId: z.string(),
      baseVersion: z.union([z.number(), z.string()]),
      entity,
    })
    .passthrough(),
  "POST /imports": z
    .object({ items: z.array(entity).max(20000) })
    .passthrough(),
  "POST /vault/note": z
    .object({
      path: z.string(),
      content: z.string(),
      expectedHash: z.string().nullable(),
    })
    .passthrough(),
};
/**
 * @typedef {object} RoutePolicy
 * @property {boolean} public Reachable without a session.
 * @property {boolean} room Allowed for the room's agent credential.
 * @property {z.ZodType} body Request body schema.
 * @property {z.ZodType} query Query-string schema.
 */
/** @type {Map<string, RoutePolicy>} */
export const ROUTES = new Map([
  [
    "GET /health",
    {
      public: true,
      room: false,
      body: schemas["GET /health"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /auth/status",
    {
      public: true,
      room: false,
      body: schemas["GET /auth/status"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /auth/csrf",
    {
      public: true,
      room: false,
      body: schemas["GET /auth/csrf"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /auth/setup",
    {
      public: true,
      room: false,
      body: schemas["POST /auth/setup"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /auth/login",
    {
      public: true,
      room: false,
      body: schemas["POST /auth/login"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /mundo/overview",
    {
      public: false,
      room: false,
      body: schemas["GET /mundo/overview"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /mundo/document",
    {
      public: false,
      room: false,
      body: schemas["GET /mundo/document"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /mundo/media",
    {
      public: false,
      room: false,
      body: schemas["GET /mundo/media"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /mundo/briefs",
    {
      public: false,
      room: false,
      body: schemas["POST /mundo/briefs"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /mundo/agents",
    {
      public: false,
      room: false,
      body: schemas["POST /mundo/agents"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /mundo/tasks",
    {
      public: false,
      room: false,
      body: schemas["POST /mundo/tasks"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /mundo/tasks/status",
    {
      public: false,
      room: false,
      body: schemas["POST /mundo/tasks/status"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /sala",
    {
      public: false,
      room: false,
      body: schemas["GET /sala"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /sala/tablero",
    {
      public: false,
      room: false,
      body: schemas["POST /sala/tablero"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /sala/encargos",
    {
      public: false,
      room: false,
      body: schemas["POST /sala/encargos"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /sala/agentes",
    {
      public: false,
      room: false,
      body: schemas["POST /sala/agentes"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /sala/agentes/borrar",
    {
      public: false,
      room: false,
      body: schemas["POST /sala/agentes/borrar"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /sala/imagen",
    {
      public: false,
      room: false,
      body: schemas["GET /sala/imagen"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /vault/files",
    {
      public: false,
      room: true,
      body: schemas["GET /vault/files"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /vault/note",
    {
      public: false,
      room: true,
      body: schemas["GET /vault/note"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /vault/note",
    {
      public: false,
      room: true,
      body: schemas["POST /vault/note"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /auth/logout",
    {
      public: false,
      room: false,
      body: schemas["POST /auth/logout"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /auth/totp/start",
    {
      public: false,
      room: false,
      body: schemas["POST /auth/totp/start"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /auth/totp/enable",
    {
      public: false,
      room: false,
      body: schemas["POST /auth/totp/enable"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /vault/status",
    {
      public: false,
      room: false,
      body: schemas["GET /vault/status"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /items",
    {
      public: false,
      room: false,
      body: schemas["GET /items"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /mutations",
    {
      public: false,
      room: false,
      body: schemas["POST /mutations"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /imports",
    {
      public: false,
      room: false,
      body: schemas["POST /imports"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /export",
    {
      public: false,
      room: false,
      body: schemas["GET /export"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /finance/overview",
    {
      public: false,
      room: true,
      body: schemas["GET /finance/overview"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /finance/ops",
    {
      public: false,
      room: true,
      body: schemas["POST /finance/ops"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /finance/ledger",
    {
      public: false,
      room: false,
      body: schemas["GET /finance/ledger"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /events",
    {
      public: false,
      room: false,
      body: schemas["GET /events"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
]);
// Maletín: shared folder between the owner and the agents. Agents may use all of it
// (the handlers restrict what they can write or remove); pinning is the owner's.
const anyQuery = z.record(z.string(), z.string());
for (const [key, body] of /** @type {Array<[string, z.ZodType]>} */ ([
  ["GET /aprobaciones", object],
  [
    "POST /aprobaciones/decidir",
    z
      .object({
        id: z.uuid(),
        aprobar: z.boolean(),
        requestId: z.uuid().optional(),
      })
      .strict(),
  ],
  ["GET /oauth/clientes", object],
  [
    "POST /oauth/clientes/revocar",
    z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  ],
  ["GET /agentes/sesiones", object],
  ["GET /agentes/espacios", object],
  [
    "POST /agentes/espacios",
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        repositorio: z.string().min(1).max(100).nullable(),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
  ],
  ["GET /agentes/capacidades", object],
  ["GET /agentes/mi-capacidad", object],
  ["GET /agentes/herramientas/catalogo", object],
  [
    "POST /agentes/herramientas/perfiles",
    z
      .object({
        profileId: z.enum([
          "investigacion",
          "ejecucion",
          "coordinacion",
          "integracion",
        ]),
        allowedMcps: z.array(z.string().min(1).max(60)).max(30).optional(),
        allowedOperations: z
          .array(z.string().min(1).max(80))
          .max(50)
          .optional(),
        allowedEffectCategories: z
          .array(
            z.enum([
              "external_message",
              "job_application",
              "financial_spend",
              "destructive_change",
            ]),
          )
          .max(10)
          .optional(),
        allowBilledApi: z.boolean().optional(),
        description: z.string().max(400).optional(),
      })
      .strict(),
  ],
  [
    "POST /agentes/herramientas/skills/resolver",
    z
      .object({
        motor: z.enum(["claude", "codex", "agy", "deepseek"]).optional(),
        profileId: z
          .enum(["investigacion", "ejecucion", "coordinacion", "integracion"])
          .optional(),
        parentProfileId: z
          .enum(["investigacion", "ejecucion", "coordinacion", "integracion"])
          .optional(),
        taskType: z.string().max(100).optional(),
        skillIds: z.array(z.string().min(1).max(100)).max(50).optional(),
        billingAuthorized: z.boolean().optional(),
        runtimeProbes: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  ],
  ["GET /agentes/proyectos-lanzador", object],
  ["GET /agentes/modelos-lanzador", object],
  ["GET /agentes/uso", object],
]))
  ROUTES.set(key, { public: false, room: false, body, query: anyQuery });
// Changes and PR draft of one session: a user session and a UUID, nothing else.
// Long-lived SSE of one harness: only a user session, and the id must be a UUID.
for (const [
  key,
  room,
  body,
] of /** @type {Array<[string, boolean, z.ZodType]>} */ ([
  ["GET /files", true, object],
  ["GET /files/download", true, object],
  ["GET /files/chunk", true, object],
  [
    "POST /files",
    true,
    z
      .object({
        area: z.string(),
        name: z.string().max(200),
        note: z.string().max(300).optional(),
        encoding: z.enum(["utf8", "base64"]),
        content: z.string(),
      })
      .passthrough(),
  ],
  ["POST /files/raw", true, object],
  ["POST /files/trash", true, z.object({ id: z.string() }).passthrough()],
  ["POST /files/restore", false, z.object({ id: z.string() }).passthrough()],
  [
    "POST /files/pin",
    false,
    z.object({ id: z.string(), pinned: z.boolean() }).passthrough(),
  ],
]))
  ROUTES.set(key, { public: false, room, body, query: anyQuery });

// user requests

ROUTES.set("GET /solicitudes", {
  public: false,
  room: true,
  body: object,
  query: z
    .object({
      workOrderId: z.uuid().optional(),
      kind: z.enum(["question", "approval"]).optional(),
      status: z.string().max(40).optional(),
    })
    .strict(),
});
ROUTES.set("GET /solicitudes/detalle", {
  public: false,
  room: true,
  body: object,
  query: z
    .object({
      id: z.union([z.uuid(), z.string().regex(/^req_[0-9A-Za-z_-]{6,64}$/)]),
    })
    .strict(),
});
ROUTES.set("POST /solicitudes/preguntar", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid().optional(),
      requestId: z.uuid().optional(),
      workOrderId: z.uuid().nullable().optional(),
      sessionId: z.string().max(120).nullable().optional(),
      memberId: z.string().max(100).nullable().optional(),
      titulo: z.string().min(1).max(200).optional(),
      title: z.string().min(1).max(200).optional(),
      pregunta: z.string().min(1).max(8000).optional(),
      prompt: z.string().min(1).max(8000).optional(),
      opciones: z.array(z.string().min(1).max(400)).max(20).optional(),
      options: z.array(z.string().min(1).max(400)).max(20).optional(),
      permiteTextoLibre: z.boolean().optional(),
      allowFreeText: z.boolean().optional(),
      nativeRequestId: z.string().max(120).nullable().optional(),
      nativeSessionId: z.string().max(120).nullable().optional(),
      nativeTurnId: z.string().max(120).nullable().optional(),
      ttlMs: z.number().int().positive().max(86400000).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/esperar", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.union([z.uuid(), z.string().regex(/^req_[0-9A-Za-z_-]{6,64}$/)]),
      timeout: z.number().int().min(0).max(240000).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/aprobacion", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid().optional(),
      requestId: z.uuid().optional(),
      workOrderId: z.uuid().nullable().optional(),
      sessionId: z.string().max(120).nullable().optional(),
      memberId: z.string().max(100).nullable().optional(),
      title: z.string().min(1).max(200).optional(),
      prompt: z.string().min(1).max(8000),
      action: z.string().min(1).max(200),
      recipient: z.string().min(1).max(400),
      contentHash: z.string().max(200).optional(),
      changes: z
        .union([z.string().max(16000), z.record(z.string(), z.unknown())])
        .optional(),
      cost: z.union([z.string().max(100), z.number()]).optional(),
      scope: z.string().min(1).max(120),
      nativeRequestId: z.string().max(120).nullable().optional(),
      nativeSessionId: z.string().max(120).nullable().optional(),
      nativeTurnId: z.string().max(120).nullable().optional(),
      ttlMs: z.number().int().positive().max(86400000).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/responder", {
  public: false,
  room: false,
  body: z
    .object({
      id: z.uuid(),
      requestId: z.uuid(),
      option: z.string().max(400).optional(),
      freeText: z.string().max(16000).optional(),
      approve: z.boolean().optional(),
      origin: z.string().max(40).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      expectedNativeTurnId: z.string().max(120).optional(),
      action: z.string().max(200).optional(),
      recipient: z.string().max(400).optional(),
      contentHash: z.string().max(200).optional(),
      changes: z
        .union([z.string().max(16000), z.record(z.string(), z.unknown())])
        .optional(),
      cost: z.union([z.string().max(100), z.number()]).optional(),
      scope: z.string().max(120).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/cerrar-turno", {
  public: false,
  room: true,
  body: z
    .object({
      sessionId: z.string().max(120).optional(),
      nativeTurnId: z.string().max(120).optional(),
      reason: z.enum(["closed_by_turn", "interrupted", "expired"]).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/verificar-ejecucion", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid(),
      action: z.string().max(200).optional(),
      recipient: z.string().max(400).optional(),
      contentHash: z.string().max(200).optional(),
      changes: z
        .union([z.string().max(16000), z.record(z.string(), z.unknown())])
        .optional(),
      cost: z.union([z.string().max(100), z.number()]).optional(),
      scope: z.string().max(120).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /solicitudes/entrega", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid(),
      status: z.enum([
        "entregando",
        "entregada",
        "confirmada",
        "entrega_incierta",
      ]),
      note: z.string().max(300).optional(),
    })
    .strict(),
  query: anyQuery,
});

// runtime tool catalog (room-readable) and protected effects executor
ROUTES.set("GET /agentes/mi-capacidad", {
  public: false,
  room: true,
  body: object,
  query: anyQuery,
});
ROUTES.set("POST /agentes/capacidades/token", {
  public: false,
  room: false,
  body: z
    .object({
      sessionId: z.uuid().optional(),
      parentSessionId: z.uuid().optional(),
      workOrderId: z.uuid().optional(),
      memberId: z.string().min(1).max(100).optional(),
      actor: z.string().min(1).max(40).optional(),
      profileId: z
        .enum(["investigacion", "ejecucion", "coordinacion", "integracion"])
        .optional(),
      parentProfileId: z
        .enum(["investigacion", "ejecucion", "coordinacion", "integracion"])
        .optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("GET /agentes/herramientas/catalogo", {
  public: false,
  room: true,
  body: object,
  query: anyQuery,
});
ROUTES.set("POST /agentes/herramientas/skills/resolver", {
  public: false,
  room: true,
  body: /** @type {RoutePolicy} */ (
    ROUTES.get("POST /agentes/herramientas/skills/resolver")
  ).body,
  query: anyQuery,
});
ROUTES.set("GET /efectos", {
  public: false,
  room: true,
  body: object,
  query: z
    .object({
      workOrderId: z.uuid().optional(),
      status: z.string().max(40).optional(),
    })
    .strict(),
});
ROUTES.set("GET /efectos/detalle", {
  public: false,
  room: true,
  body: object,
  query: z.object({ id: z.uuid() }).strict(),
});
ROUTES.set("POST /efectos/preparar", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid().optional(),
      requestId: z.uuid().optional(),
      category: z.enum([
        "external_message",
        "job_application",
        "financial_spend",
        "destructive_change",
      ]),
      action: z.string().min(1).max(200),
      recipient: z.string().min(1).max(400),
      content: z.string().max(16000).optional(),
      contentHash: z.string().max(200).optional(),
      changes: z
        .union([z.string().max(16000), z.record(z.string(), z.unknown())])
        .optional(),
      cost: z.union([z.string().max(100), z.number()]).optional(),
      scope: z.string().min(1).max(120).optional(),
      workOrderId: z.uuid().nullable().optional(),
      sessionId: z.string().max(120).nullable().optional(),
      memberId: z.string().max(100).nullable().optional(),
      toolProfileId: z
        .enum(["investigacion", "ejecucion", "coordinacion", "integracion"])
        .optional(),
      billingAuthorized: z.boolean().optional(),
      billingApprovalId: z.uuid().optional(),
      title: z.string().min(1).max(200).optional(),
      prompt: z.string().min(1).max(8000).optional(),
      nativeRequestId: z.string().max(120).nullable().optional(),
      nativeSessionId: z.string().max(120).nullable().optional(),
      nativeTurnId: z.string().max(120).nullable().optional(),
      ttlMs: z.number().int().positive().max(86400000).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /efectos/ejecutar", {
  public: false,
  room: true,
  body: z
    .object({
      id: z.uuid(),
      requestId: z.uuid(),
      expectedNativeTurnId: z.string().max(120).optional(),
      action: z.string().max(200).optional(),
      recipient: z.string().max(400).optional(),
      contentHash: z.string().max(200).optional(),
      changes: z
        .union([z.string().max(16000), z.record(z.string(), z.unknown())])
        .optional(),
      cost: z.union([z.string().max(100), z.number()]).optional(),
      scope: z.string().max(120).optional(),
    })
    .strict(),
  query: anyQuery,
});
ROUTES.set("POST /efectos/conciliar", {
  public: false,
  room: false,
  body: z
    .object({
      id: z.uuid(),
      requestId: z.uuid(),
      outcome: z.enum(["confirmada", "fallida"]),
      note: z.string().max(300).optional(),
    })
    .strict(),
  query: anyQuery,
});

// Threads (ADR 0010). The launcher validates commands with the shared
// contracts; these schemas only bound sizes and identifiers.
const threadAgent = z
  .object({
    engine: z.enum(["claude", "codex", "agy", "deepseek"]),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][\w.:[\]-]{0,79}$/)
      .optional(),
    effort: z
      .string()
      .regex(/^[a-z]{1,10}$/)
      .optional(),
  })
  .strict();
const threadAttachments = z
  .array(z.object({}).passthrough())
  .max(10)
  .optional();
const threadIdQuery = z
  .object({ id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/) })
  .strict();
const afterQuery = {
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
};
for (const [
  key,
  room,
  body,
  query,
] of /** @type {Array<[string, boolean, z.ZodType, z.ZodType]>} */ ([
  [
    "GET /threads",
    false,
    object,
    z
      .object({
        status: z.string().max(200).optional(),
        parent: z.string().max(80).optional(),
        archived: z.enum(["0", "1"]).optional(),
      })
      .strict(),
  ],
  [
    "POST /threads",
    false,
    z
      .object({
        prompt: z.string().min(1).max(100_000),
        kind: z.enum(["repo", "scratch"]),
        title: z.string().min(1).max(200).optional(),
        repoPath: z.string().min(1).max(200).optional(),
        baseBranch: z.string().min(1).max(200).optional(),
        agent: threadAgent,
        autonomy: z.enum(["auto-worktree", "ask", "read-only"]).optional(),
        attachments: threadAttachments,
      })
      .strict(),
    anyQuery,
  ],
  ["GET /threads/detalle", false, object, threadIdQuery],
  [
    "GET /threads/flujo",
    false,
    object,
    z
      .object({
        id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/),
        ...afterQuery,
      })
      .strict(),
  ],
  ["GET /threads/feed", false, object, z.object(afterQuery).strict()],
  [
    "POST /threads/mensajes",
    false,
    z
      .object({
        id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/),
        text: z.string().min(1).max(100_000),
        mode: z.enum(["send", "steer", "queue"]),
        attachments: threadAttachments,
        agent: threadAgent.optional(),
      })
      .strict(),
    anyQuery,
  ],
  [
    "POST /threads/interrumpir",
    false,
    z.object({ id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/) }).strict(),
    anyQuery,
  ],
  [
    "POST /threads/responder",
    false,
    z
      .object({
        id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/),
        requestId: z.string().regex(/^req_[0-9A-Za-z_-]{6,64}$/),
        answer: z.object({}).passthrough(),
      })
      .strict(),
    anyQuery,
  ],
  [
    "POST /threads/cerrar",
    false,
    z
      .object({
        id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/),
        mode: z.enum(["pr", "merge", "discard"]),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(50_000).optional(),
      })
      .strict(),
    anyQuery,
  ],
  [
    "POST /threads/archivar",
    false,
    z.object({ id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/) }).strict(),
    anyQuery,
  ],
  [
    "GET /threads/diff",
    false,
    object,
    z
      .object({
        id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/),
        turnId: z
          .string()
          .regex(/^trn_[0-9A-Za-z_-]{6,64}$/)
          .optional(),
      })
      .strict(),
  ],
  ["GET /bandeja", false, object, z.object({}).strict()],
  [
    "POST /threads/agente/preguntar",
    true,
    z
      .object({
        title: z.string().min(1).max(300),
        body: z.string().max(20_000).optional(),
        options: z.array(z.string().min(1).max(200)).max(20).optional(),
        fields: z.array(z.object({}).passthrough()).min(1).max(20).optional(),
      })
      .strict(),
    anyQuery,
  ],
  [
    "GET /threads/agente/solicitud",
    true,
    object,
    z.object({ id: z.string().regex(/^req_[0-9A-Za-z_-]{6,64}$/) }).strict(),
  ],
]))
  ROUTES.set(key, { public: false, room, body, query });

/**
 * @param {string | undefined} method
 * @param {string} route
 */
export const routePolicy = (method, route) => ROUTES.get(method + " " + route);
