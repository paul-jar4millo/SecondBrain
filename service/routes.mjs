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
  "POST /room/board": z
    .object({
      id: z.string(),
      guardar: z.boolean(),
      espacio: z.string().optional(),
    })
    .passthrough(),
  "POST /room/work-orders": z
    .object({
      id: z.string(),
      mode: z.string(),
      instruction: z.string().optional(),
      project: z.string().optional(),
    })
    .passthrough(),
  "POST /room/agents/delete": z.object({ id: z.string() }).passthrough(),
  "POST /finance/ops": z
    .object({ op: z.string(), requestId: z.string().max(100).optional() })
    .passthrough(),
  "POST /world/briefs": z
    .object({ title: z.string(), brief: z.string(), slug: z.string() })
    .passthrough(),
  "POST /world/agents": z
    .object({ id: z.string(), enabled: z.boolean(), notes: z.string() })
    .passthrough(),
  "POST /world/tasks": z
    .object({
      agentId: z.string(),
      instruction: z.string(),
      videoId: z.string().nullable().optional(),
    })
    .passthrough(),
  "POST /world/tasks/status": z
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
    "GET /world/overview",
    {
      public: false,
      room: false,
      body: schemas["GET /world/overview"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /world/document",
    {
      public: false,
      room: false,
      body: schemas["GET /world/document"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /world/media",
    {
      public: false,
      room: false,
      body: schemas["GET /world/media"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /world/briefs",
    {
      public: false,
      room: false,
      body: schemas["POST /world/briefs"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /world/agents",
    {
      public: false,
      room: false,
      body: schemas["POST /world/agents"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /world/tasks",
    {
      public: false,
      room: false,
      body: schemas["POST /world/tasks"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /world/tasks/status",
    {
      public: false,
      room: false,
      body: schemas["POST /world/tasks/status"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /room",
    {
      public: false,
      room: false,
      body: schemas["GET /room"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /room/board",
    {
      public: false,
      room: false,
      body: schemas["POST /room/board"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /room/work-orders",
    {
      public: false,
      room: false,
      body: schemas["POST /room/work-orders"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /room/agents",
    {
      public: false,
      room: false,
      body: schemas["POST /room/agents"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "POST /room/agents/delete",
    {
      public: false,
      room: false,
      body: schemas["POST /room/agents/delete"] || object,
      query: z.record(z.string(), z.string()),
    },
  ],
  [
    "GET /room/image",
    {
      public: false,
      room: false,
      body: schemas["GET /room/image"] || object,
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
  ["GET /approvals", object],
  [
    "POST /approvals/decide",
    z
      .object({
        id: z.uuid(),
        aprobar: z.boolean(),
        requestId: z.uuid().optional(),
      })
      .strict(),
  ],
  ["GET /oauth/clients", object],
  [
    "POST /oauth/clients/revoke",
    z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  ],
  ["GET /agents/workspaces", object],
  [
    "POST /agents/workspaces",
    z.union([
      z
        .object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          repository: z.string().min(1).max(100).nullable(),
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          repositorio: z.string().min(1).max(100).nullable(),
          revision: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  ],
  ["GET /agents/capabilities", object],
  ["GET /agents/self-capability", object],
  ["GET /agents/tools/catalog", object],
  [
    "POST /agents/tools/profiles",
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
    "POST /agents/tools/skills/resolve",
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
  ["GET /agents/projects", object],
  ["GET /agents/models", object],
  ["GET /agents/usage", object],
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

ROUTES.set("GET /requests", {
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
ROUTES.set("GET /requests/detail", {
  public: false,
  room: true,
  body: object,
  query: z
    .object({
      id: z.union([z.uuid(), z.string().regex(/^req_[0-9A-Za-z_-]{6,64}$/)]),
    })
    .strict(),
});
ROUTES.set("POST /requests/ask", {
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
ROUTES.set("POST /requests/wait", {
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
ROUTES.set("POST /requests/approval", {
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
ROUTES.set("POST /requests/answer", {
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
ROUTES.set("POST /requests/close-turn", {
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
ROUTES.set("POST /requests/verify-execution", {
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
ROUTES.set("POST /requests/delivery", {
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
ROUTES.set("GET /agents/self-capability", {
  public: false,
  room: true,
  body: object,
  query: anyQuery,
});
ROUTES.set("POST /agents/capabilities/token", {
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
ROUTES.set("GET /agents/tools/catalog", {
  public: false,
  room: true,
  body: object,
  query: anyQuery,
});
ROUTES.set("POST /agents/tools/skills/resolve", {
  public: false,
  room: true,
  body: /** @type {RoutePolicy} */ (
    ROUTES.get("POST /agents/tools/skills/resolve")
  ).body,
  query: anyQuery,
});
ROUTES.set("GET /effects", {
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
ROUTES.set("GET /effects/detail", {
  public: false,
  room: true,
  body: object,
  query: z.object({ id: z.uuid() }).strict(),
});
ROUTES.set("POST /effects/prepare", {
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
ROUTES.set("POST /effects/execute", {
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
ROUTES.set("POST /effects/reconcile", {
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
        flowTemplateId: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,63}$/)
          .optional(),
        stageAgents: z
          .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), threadAgent)
          .optional(),
        attachments: threadAttachments,
      })
      .strict(),
    anyQuery,
  ],
  ["GET /threads/detail", false, object, threadIdQuery],
  [
    "GET /threads/stream",
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
    "POST /threads/messages",
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
    "POST /threads/interrupt",
    false,
    z.object({ id: z.string().regex(/^thr_[0-9A-Za-z_-]{6,64}$/) }).strict(),
    anyQuery,
  ],
  [
    "POST /threads/answer",
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
    "POST /threads/close",
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
    "POST /threads/archive",
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
  ["GET /inbox", false, object, z.object({}).strict()],
  ["GET /flows", false, object, z.object({}).strict()],
  [
    "POST /threads/agent/ask",
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
    "GET /threads/agent/request",
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
