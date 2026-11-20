import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { routePolicy } from "./routes.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat, realpath, open } from "node:fs/promises";
import { readFileSync, watch } from "node:fs";
import { zip, strToU8 } from "fflate";
import { acquireInstance } from "./instance.mjs";
import { hash } from "./vault.mjs";
import {
  Vault,
  actorContext,
  discoverVault,
  Failure,
  stableId,
} from "./vault.mjs";
import { History } from "./history.mjs";
import { DomainError } from "./domain-error.mjs";
import { GitHistory } from "./vault-git.mjs";
import { Auth } from "./auth.mjs";
import { Finance, mexicoDay } from "./finance.mjs";
import { createSala } from "./sala.mjs";
import { createMundo } from "./mundo.mjs";
import { createLanzador } from "./lanzador.mjs";
import { crearMcpRemoto } from "./mcp-remoto.mjs";
import { ConflictoAprobacion, crearColaAprobaciones } from "./aprobaciones.mjs";
import { sendItems } from "./http-items.mjs";
import { createSharedFiles, downloadHeaders } from "./shared-files.mjs";
import { pipeline } from "node:stream/promises";
import { operationalStatus } from "./operational-status.mjs";
import { createWorkOrderStore } from "./work-orders.mjs";
import { createUserRequestStore } from "./user-requests.mjs";
import { createEffectsExecutor } from "./effects-executor.mjs";
const appRoot = fileURLToPath(new URL("..", import.meta.url));
// Reported by /health; the release package always ships service/package.json.
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
export async function createApplication(options = {}) {
  const root = await discoverVault(
    options.vaultRoot || process.env.VAULT_ROOT || "/srv/secondbrain/vault",
  );
  const dataDirectory = path.resolve(
    options.dataDirectory ||
      process.env.DATA_DIR ||
      path.join(appRoot, ".data"),
  );
  const history = new History(path.join(dataDirectory, "history"));
  await history
    .prune()
    .catch((e) => console.error("No se pudo depurar el historial:", e));
  const versioning =
    process.env.VAULT_GIT === "on" ? new GitHistory(root) : null;
  await versioning?.check();
  const vault = new Vault(root, path.join(dataDirectory, "operations"), {
    history,
    versioning,
  });
  const finance = new Finance(vault);
  await vault.recover();
  // The room credential grants only the routes used by the Brain tools below.
  // It is distinct from the token that controls the runner; older installs share one.
  const brainTokenFile =
    options.agentes?.brainTokenFile ?? process.env.AGENTES_BRAIN_TOKEN_FILE;
  const roomTokenFile =
    brainTokenFile ??
    options.agentes?.tokenFile ??
    process.env.AGENTES_TOKEN_FILE;
  const roomToken =
    options.agentes?.brainToken ??
    (brainTokenFile ? undefined : options.agentes?.token) ??
    (roomTokenFile
      ? (await readFile(roomTokenFile, "utf8")).trim()
      : undefined);
  const auth = new Auth(dataDirectory, {
    roomToken,
    production: options.production ?? process.env.NODE_ENV === "production",
    trustedProxy: process.env.TRUSTED_PROXY || "127.0.0.1",
    limit: options.authLimit || 10,
    // Local use is passwordless; login is required in production or with AUTH=on.
    enabled:
      options.auth ??
      (process.env.AUTH === "on" ||
        (process.env.NODE_ENV === "production" && process.env.AUTH !== "off")),
  });
  await auth.init();
  const sala = await createSala(dataDirectory, Failure);
  const mundo = createMundo(
    dataDirectory,
    Failure,
    options.mundoPaquete ?? process.env.MUNDO_PAQUETE,
  );
  const lanzador = createLanzador(Failure, options.lanzador);
  const clients = new Set();
  const watchers = [];
  let changeTimer;
  const change = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      for (const response of clients) response.write("data: changed\n\n");
    }, 150);
    changeTimer.unref();
  };
  const stopLanzadorEvents = lanzador.subscribe(change);
  let servidorHttp;
  const mcpRemoto = await crearMcpRemoto({
    directory: path.join(dataDirectory, "oauth"),
    auth,
    Failure,
    baseUrl: () => `http://127.0.0.1:${servidorHttp.address().port}/api/v1`,
    now: options.mcpRemoto?.now,
    onChange: change,
  });
  const aprobaciones = await crearColaAprobaciones(
    path.join(dataDirectory, "aprobaciones"),
    { ...options.aprobaciones, onChange: change },
  );
  const workOrders = await createWorkOrderStore(
    path.join(dataDirectory, "encargos"),
    { ...options.workOrders, onChange: change },
  );
  const userRequests = await createUserRequestStore(
    path.join(dataDirectory, "solicitudes"),
    {
      ...options.userRequests,
      onChange: change,
      onEvent: (workOrderId, ev) => workOrders.appendEvent(workOrderId, ev),
    },
  );
  const effects = await createEffectsExecutor(
    path.join(dataDirectory, "efectos"),
    {
      userRequests,
      workOrders,
      ...options.effects,
      onChange: change,
    },
  );
  // The launcher lists sessions as an array; older fixtures wrap it.
  const sesionesLanzador = async () => {
    const estado = await lanzador.leer().catch(() => null);
    if (Array.isArray(estado)) return estado;
    return Array.isArray(estado?.sesiones) ? estado.sesiones : [];
  };
  const runStoreOp = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DomainError) {
        throw Object.assign(new Failure(error.message, error.status || 400), {
          ...(error.recibo ? { recibo: error.recibo } : {}),
          ...(error.solicitud ? { solicitud: error.solicitud } : {}),
          ...(error.snapshot ? { snapshot: error.snapshot } : {}),
          ...(error.operacion ? { operacion: error.operacion } : {}),
        });
      }
      throw error;
    }
  };
  const SERVICE_TOOL_PROFILES = {
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
  const MOTOR_ACTOR = {
    claude: "ambar",
    codex: "menta",
    agy: "lira",
    deepseek: "marina",
  };
  const intersectList = (a = [], b = []) => {
    const allowed = new Set(b);
    return a.filter((item) => allowed.has(item));
  };
  const intersectProfileBounds = (parent, child) => {
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
  const resolveServerProfile = async (
    profileId = "ejecucion",
    parentProfile = null,
  ) => {
    let base =
      SERVICE_TOOL_PROFILES[profileId] || SERVICE_TOOL_PROFILES.ejecucion;
    try {
      const cat = await lanzador.catalogoHerramientas({ profileId });
      if (cat?.profile?.id === profileId) base = cat.profile;
    } catch {
      /* standalone service without launcher stays bounded by local definitions */
    }
    return parentProfile
      ? intersectProfileBounds(parentProfile, base)
      : structuredClone(base);
  };
  const hasVerifiedBillingGrant = ({
    billingApprovalId = null,
    fromAgent = true,
  } = {}) => {
    if (!fromAgent && options.operatorBillingPolicy?.allowBilledApi === true) {
      return true;
    }
    if (!billingApprovalId || typeof billingApprovalId !== "string")
      return false;
    const grantReq = userRequests.get(billingApprovalId);
    if (
      !grantReq ||
      grantReq.kind !== "approval" ||
      grantReq.status !== "confirmada" ||
      grantReq.receipt?.decision !== "aprobada"
    ) {
      return false;
    }
    if (grantReq.expiresAt && Date.parse(grantReq.expiresAt) <= Date.now()) {
      return false;
    }
    const approver = String(grantReq.receipt?.by || "");
    if (!approver || approver.startsWith("agente")) return false;
    return /billing|financial_spend|deepseek|api_facturada/i.test(
      `${grantReq.action || ""} ${grantReq.scope || ""}`,
    );
  };
  const agentHeaders = (request) => {
    const rawAgent =
      typeof request.headers["x-sb-agente"] === "string"
        ? request.headers["x-sb-agente"].trim()
        : "";
    const rawSession =
      typeof request.headers["x-sb-sesion"] === "string"
        ? request.headers["x-sb-sesion"].trim()
        : "";
    return {
      agentId: rawAgent || null,
      sessionUuid: /^[a-f0-9-]{36}$/i.test(rawSession) ? rawSession : null,
    };
  };
  const assertAgentCapabilityForRoute = (request, routeKey) => {
    if (!auth.isAgent(request)) return null;
    const cap = auth.capabilityOf(request);
    const spoofedProfile = request.headers["x-sb-tool-profile"];
    if (typeof spoofedProfile === "string" && spoofedProfile.trim()) {
      if (!cap || spoofedProfile.trim() !== cap.profileId) {
        throw new Failure(
          "El perfil de herramientas se impone en servidor; encabezado de perfil rechazado.",
          403,
        );
      }
    }
    if (!cap) return null;
    const { agentId, sessionUuid } = agentHeaders(request);
    const allowedAgentIds = new Set([cap.actor, cap.memberId].filter(Boolean));
    if (agentId && allowedAgentIds.size > 0 && !allowedAgentIds.has(agentId)) {
      throw new Failure(
        "La identidad del agente no coincide con la capacidad asignada a la sesión.",
        403,
      );
    }
    if (sessionUuid && cap.sessionId && sessionUuid !== cap.sessionId) {
      throw new Failure(
        "El identificador de sesión no coincide con la capacidad asignada.",
        403,
      );
    }
    const ops = new Set(cap.allowedOperations || []);
    const requireAny = (...required) => {
      if (!required.some((op) => ops.has(op))) {
        throw new Failure(
          `El perfil «${cap.profileId}» no autoriza esta operación (${required.join(" | ")}).`,
          403,
        );
      }
    };
    switch (routeKey) {
      case "GET /agentes/mi-capacidad":
      case "GET /agentes/herramientas/catalogo":
      case "POST /agentes/herramientas/skills/resolver":
      case "GET /efectos":
      case "GET /efectos/detalle":
      case "GET /solicitudes":
      case "GET /solicitudes/detalle":
      case "GET /encargos/detalle":
      case "GET /encargos/artefactos/descargar":
      case "POST /encargos/eventos":
      case "GET /agentes/conversacion/cola":
        return cap;
      case "GET /vault/files":
      case "GET /vault/note":
        requireAny("vault.read", "vault.search");
        return cap;
      case "POST /vault/note":
        requireAny("vault.write");
        return cap;
      case "GET /finance/overview":
        requireAny("vault.read", "finance.read");
        return cap;
      case "POST /finance/ops":
        requireAny("finance.write");
        return cap;
      case "GET /files":
      case "GET /files/download":
      case "GET /files/chunk":
        requireAny("file.read", "vault.read");
        return cap;
      case "POST /files":
      case "POST /files/raw":
      case "POST /files/trash":
        requireAny("file.write", "vault.write", "artifact.publish");
        return cap;
      case "POST /solicitudes/preguntar":
      case "POST /solicitudes/esperar":
        requireAny("user.ask");
        return cap;
      case "POST /solicitudes/aprobacion":
      case "POST /solicitudes/verificar-ejecucion":
      case "POST /solicitudes/entrega":
      case "POST /solicitudes/cerrar-turno":
        requireAny("effect.prepare", "user.ask");
        return cap;
      case "POST /efectos/preparar":
      case "POST /efectos/ejecutar":
        requireAny("effect.prepare");
        return cap;
      case "POST /equipo/encargar":
        requireAny("team.coordinate");
        if ((cap.depth || 1) >= (cap.maxDepth || 2)) {
          throw new Failure(
            "Profundidad máxima de delegación alcanzada para esta credencial.",
            403,
          );
        }
        return cap;
      case "POST /equipo/esperar":
      case "POST /equipo/estado":
      case "POST /equipo/mensaje":
      case "POST /equipo/bandeja":
      case "POST /equipo/entregar":
        return cap;
      default:
        throw new Failure(
          "Operación no autorizada para credencial acotada de agente.",
          403,
        );
    }
  };
  const canAgentAccessScopedRecord = (request, record) => {
    if (!auth.isAgent(request)) return true;
    const cap = auth.capabilityOf(request);
    const { agentId, sessionUuid } = agentHeaders(request);
    if (cap) {
      if (
        cap.workOrderId &&
        record.workOrderId &&
        record.workOrderId !== cap.workOrderId
      ) {
        return false;
      }
      if (
        cap.sessionId &&
        record.sessionId &&
        record.sessionId !== cap.sessionId
      ) {
        return false;
      }
      if (cap.memberId && record.memberId && record.memberId !== cap.memberId) {
        return false;
      }
      if (!record.sessionId && !record.memberId && cap.workOrderId) {
        return record.workOrderId === cap.workOrderId;
      }
      return Boolean(
        (cap.sessionId && record.sessionId === cap.sessionId) ||
        (cap.memberId && record.memberId === cap.memberId) ||
        (cap.actor && record.memberId === cap.actor),
      );
    }
    if (agentId && record.memberId && record.memberId !== agentId) return false;
    if (sessionUuid && record.sessionId && record.sessionId !== sessionUuid) {
      return false;
    }
    if (
      record.memberId &&
      !agentId &&
      (!sessionUuid || record.sessionId !== sessionUuid)
    ) {
      return false;
    }
    return true;
  };
  const activeSessionBridges = new Map();
  const sessionWorkOrderLinks = new Map();
  /** Sessions that received a message while their bridge was open. */
  const followUpTurns = new Set();
  let closed = false;
  const bridgeSessionToWorkOrder = (
    sessionId,
    workOrderId,
    fallbackMemberId,
  ) => {
    if (!sessionId || !workOrderId) return;
    sessionWorkOrderLinks.set(sessionId, { workOrderId, fallbackMemberId });
    if (activeSessionBridges.has(sessionId)) {
      // A message sent during a turn starts another one when it ends: the
      // open bridge must outlive the first "terminada" to record it.
      followUpTurns.add(sessionId);
      return;
    }
    const controller = new AbortController();
    activeSessionBridges.set(sessionId, controller);
    const seen = new Set();
    let awaitingTurn = null;
    void (async () => {
      try {
        const upstream = await lanzador.flujo(
          sessionId,
          controller.signal,
          true,
        );
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body) {
          if (controller.signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            let state;
            try {
              state = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            for (const ev of state.events || []) {
              if (!ev?.id || seen.has(ev.id)) continue;
              seen.add(ev.id);
              if (
                ev.type === "user_request.created" ||
                ev.type === "approval.created"
              ) {
                const req = ev.payload || {};
                const qOpts = Array.isArray(req.questions?.[0]?.options)
                  ? req.questions[0].options.map((o) =>
                      typeof o === "string" ? o : o.label || String(o),
                    )
                  : req.choices || [];
                await userRequests
                  .createRequest({
                    id: req.id,
                    createRequestId: req.id,
                    kind: req.kind === "approval" ? "approval" : "question",
                    workOrderId,
                    sessionId,
                    memberId: fallbackMemberId || ev.sourceId,
                    title: req.title,
                    prompt:
                      req.questions?.[0]?.question ||
                      req.detail ||
                      req.title ||
                      "Solicitud",
                    options: qOpts,
                    nativeRequestId: req.nativeId,
                    nativeTurnId: ev.turnId,
                  })
                  .catch(() => {});
              } else {
                await workOrders
                  .appendEvent(workOrderId, {
                    id: ev.id,
                    idempotencyKey: `lz:${ev.id}`,
                    sourceId: fallbackMemberId || ev.sourceId,
                    sessionId,
                    turnId: ev.turnId,
                    nativeItemId: ev.nativeItemId,
                    correlationId: ev.correlationId,
                    provenance: "observed",
                    type: ev.type,
                    payload: ev.payload,
                  })
                  .catch(() => {});
                if (
                  ev.type === "turn.completed" ||
                  ev.type === "turn.interrupted"
                ) {
                  await userRequests
                    .markTurnClosed({
                      sessionId,
                      nativeTurnId: ev.turnId,
                      reason:
                        ev.type === "turn.interrupted"
                          ? "interrupted"
                          : "closed_by_turn",
                    })
                    .catch(() => {});
                }
              }
            }
            if (
              !["terminada", "cancelada", "interrumpida", "error"].includes(
                state.status,
              )
            ) {
              clearTimeout(awaitingTurn);
              awaitingTurn = null;
            } else if (followUpTurns.delete(sessionId)) {
              // Give the queued message time to start; a cancelled one
              // never does.
              awaitingTurn = setTimeout(() => controller.abort(), 60_000);
              awaitingTurn.unref?.();
            } else if (!awaitingTurn) {
              controller.abort();
              break;
            }
          }
        }
      } catch {
        /* Bridge terminates silently when stream closes or is aborted. */
      } finally {
        clearTimeout(awaitingTurn);
        activeSessionBridges.delete(sessionId);
        // A message that arrived while this bridge was closing.
        if (followUpTurns.delete(sessionId) && !closed)
          bridgeSessionToWorkOrder(sessionId, workOrderId, fallbackMemberId);
      }
    })();
  };
  const shared = createSharedFiles(
    options.sharedDirectory ||
      process.env.SHARED_DIR ||
      path.join(dataDirectory, "shared"),
    Failure,
    { onChange: change },
  );
  const watchDirs = (await import("node:fs/promises")).readdir(root, {
    withFileTypes: true,
  });
  for (const dir of (await watchDirs)
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        ![
          "apps",
          "skills",
          "tooling",
          "node_modules",
          "artifacts",
          "dist",
          "shared",
          "scratch",
          "library-files",
          "secrets",
        ].includes(e.name),
    )
    .map((e) => e.name)) {
    try {
      watchers.push(
        watch(path.join(root, dir), { recursive: true }, (_event, file) => {
          if (
            file &&
            String(file).endsWith(".md") &&
            !String(file)
              .split(path.sep)
              .some((p) => p.startsWith("."))
          )
            change();
        }),
      );
    } catch {}
  }
  try {
    watchers.push(
      watch(root, (_event, file) => {
        if (file && /^[^/\\]+\.md$/.test(String(file))) change();
      }),
    );
  } catch {}
  // A watched folder can disappear; an unhandled "error" event would end the process.
  for (const watcher of watchers)
    watcher.on("error", (e) =>
      console.error("Se dejó de vigilar una carpeta del vault:", e.message),
    );
  async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024)
        throw new Failure("La petición supera 12 MB.", 413);
      chunks.push(chunk);
    }
    // Parse and schema validation fail differently: only the first is "invalid JSON".
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw new Failure("JSON inválido.");
    }
    const route = new URL(request.url, "http://localhost").pathname.slice(
      "/api/v1".length,
    );
    const parsed = routePolicy(request.method, route)?.body.safeParse(value);
    if (!parsed?.success)
      throw new Failure(
        "Cuerpo de petición inválido" +
          (parsed?.error ? ": " + summarizeIssues(parsed.error.issues) : "."),
      );
    return parsed.data;
  }
  const validateNotePath = (relative) => {
    if (typeof relative !== "string" || !relative.endsWith(".md"))
      throw new Failure("Solo se admiten notas Markdown.");
  };
  function send(response, status, value) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(value === undefined ? "" : JSON.stringify(value));
  }
  const actorOf = (request) => {
    if (auth.isRoomAgent(request)) {
      const id = request.headers["x-sb-agente"];
      return /^[a-z]{1,20}$/.test(id || "") ? "agente:" + id : "agente";
    }
    if (auth.isAgent(request)) {
      const cliente = request.headers["x-sb-cliente"];
      return /^[a-z0-9-]{1,30}$/.test(cliente || "") ? "mcp:" + cliente : "mcp";
    }
    return "app";
  };
  const logger =
    options.logger ||
    (process.env.NODE_ENV === "production"
      ? (record) => console.log(JSON.stringify(record))
      : // Outside production only failures are written, so a 500 is never silent.
        (record) => {
          if (record.event === "http.error")
            console.error(JSON.stringify(record));
        });
  const handle = async (request, response) => {
    const requestId = randomUUID(),
      started = performance.now();
    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      let route = "unknown";
      try {
        const p = new URL(request.url, "http://localhost").pathname.slice(
          "/api/v1".length,
        );
        if (routePolicy(request.method, p)) route = p;
      } catch {}
      logger({
        event: "http",
        requestId,
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
    try {
      // Parsing runs inside the try: an async handler that throws would kill the process.
      let pathname;
      try {
        pathname = new URL(request.url, "http://localhost").pathname;
      } catch {
        throw new Failure("Ruta inválida.", 400);
      }
      if (
        pathname === "/mcp" ||
        pathname.startsWith("/oauth/") ||
        pathname.startsWith("/.well-known/oauth-")
      ) {
        if (await mcpRemoto.manejar(request, response, pathname)) return;
      }
      if (pathname.startsWith("/api/")) {
        response.setHeader("Cache-Control", "no-store");
        const route = pathname.slice("/api/v1".length),
          method = request.method;
        const policy = routePolicy(method, route);
        if (auth.isRoomAgent(request) && !policy?.room)
          throw new Failure(
            "La credencial de la sala solo permite herramientas de SecondBrain.",
            403,
          );
        if (!["GET", "HEAD"].includes(method) && !auth.isAgent(request))
          auth.checkCsrf(request);
        if (!policy?.public && !auth.authenticated(request))
          throw new Failure("Inicia sesión para abrir el vault.", 401);
        const callerCap = assertAgentCapabilityForRoute(
          request,
          `${method} ${route}`,
        );
        const consulta = new URL(request.url, "http://localhost").searchParams;
        const accionEquipo =
          method === "POST" &&
          /^\/equipo\/(encargar|esperar|estado|mensaje|bandeja|entregar|integrar)$/.exec(
            route,
          );
        if (accionEquipo) {
          const sesion = request.headers["x-sb-sesion"];
          const actor = request.headers["x-sb-agente"];
          if (
            !auth.isRoomAgent(request) ||
            !/^[a-f0-9-]{36}$/i.test(sesion || "") ||
            !/^(ambar|menta|lira|marina)$/.test(actor || "")
          )
            throw new Failure("Se requiere una sesión de agente activa.", 403);
          const accion = accionEquipo[1];
          const datos = await body(request);
          let forwarded = datos;
          let associatedWoId = datos.workOrderId || null;
          if (["encargar", "entregar", "integrar"].includes(accion)) {
            if (callerCap?.sessionId && sesion !== callerCap.sessionId) {
              throw new Failure(
                "La sesión padre no coincide con tu credencial.",
                403,
              );
            }
            const parentSession = (await sesionesLanzador()).find(
              (s) => s.id === sesion,
            );
            const sessionWoId =
              parentSession?.workOrderId || callerCap?.workOrderId || null;
            // An agent only acts inside the work order its session belongs to.
            if (associatedWoId && associatedWoId !== sessionWoId)
              throw new Failure("La sesión no pertenece a ese encargo.", 403);
            if (!associatedWoId && sessionWoId) {
              associatedWoId = sessionWoId;
            }
            if (accion === "encargar" && associatedWoId) {
              const wo = workOrders.get(associatedWoId);
              if (!wo) throw new Failure("Encargo no encontrado.", 404);
              if (!wo.manifest) {
                throw new Failure(
                  "El encargo debe iniciarse con un manifiesto aprobado antes de delegar al equipo.",
                  409,
                );
              }
              if (
                datos.manifestSha256 &&
                datos.manifestSha256 !== wo.manifest.sha256
              ) {
                throw new Failure(
                  "Manifiesto del encargo desactualizado; recarga el equipo.",
                  409,
                );
              }
              forwarded = {
                ...datos,
                workOrderId: wo.id,
                manifest: wo.manifest,
                manifestSha256: datos.manifestSha256 || wo.manifest.sha256,
              };
            }
          }
          let mintedChild = null;
          if (accion === "encargar" && callerCap) {
            let parentProfile = callerCap;
            const capWo = callerCap.workOrderId
              ? workOrders.get(callerCap.workOrderId)
              : null;
            const woCoord = capWo?.team?.find((m) => m.coordinator);
            if (woCoord?.toolProfileId) {
              const coordProf = await resolveServerProfile(
                woCoord.toolProfileId,
              );
              parentProfile = intersectProfileBounds(coordProf, parentProfile);
            }
            // The card the manifest approved fixes the child's profile; the
            // agent can only narrow it further.
            const manifestCard =
              datos.memberId && forwarded.manifest?.team
                ? forwarded.manifest.team.find((c) => c.id === datos.memberId)
                : null;
            const childProfile = await resolveServerProfile(
              datos.toolProfileId ||
                manifestCard?.toolProfileId ||
                callerCap.profileId ||
                "investigacion",
              parentProfile,
            );
            const preassignedSessionId = randomUUID();
            const childActor = MOTOR_ACTOR[datos.motor] || null;
            mintedChild = await auth.issueCapability({
              sessionId: preassignedSessionId,
              parentSessionId: callerCap.sessionId || sesion,
              workOrderId: associatedWoId ?? callerCap.workOrderId ?? null,
              memberId: datos.memberId || childActor || preassignedSessionId,
              actor: childActor,
              profileId: childProfile.id,
              allowedMcps: childProfile.allowedMcps,
              allowedOperations: childProfile.allowedOperations,
              allowedEffectCategories: childProfile.allowedEffectCategories,
              allowBilledApi: false,
              canDelegateBeyondSelf: false,
              depth: (callerCap.depth || 1) + 1,
              maxDepth: 2,
            });
            forwarded = {
              ...forwarded,
              id: preassignedSessionId,
              toolProfileId: childProfile.id,
              effectiveProfile: childProfile,
              capabilityToken: mintedChild.token,
              billingAuthorized: false,
            };
          }
          let resultado;
          try {
            resultado = await lanzador.equipo(accion, sesion, actor, forwarded);
            if (mintedChild && resultado?.id) {
              if (resultado.repetido) {
                // Idempotent replay: the existing child keeps its own
                // credential; the one minted for this call is not used.
                await auth.revokeCapability({
                  tokenId: mintedChild.record.id,
                });
              } else if (resultado.id !== forwarded.id) {
                await auth.bindCapabilitySession(
                  mintedChild.record.id,
                  resultado.id,
                  { rebind: true },
                );
              }
            }
          } catch (err) {
            if (mintedChild)
              await auth.revokeCapability({ tokenId: mintedChild.record.id });
            throw err;
          }
          if (accion === "encargar" && associatedWoId && resultado?.id) {
            if (resultado.structured) {
              bridgeSessionToWorkOrder(
                resultado.id,
                associatedWoId,
                resultado.memberId || datos.memberId || resultado.motor,
              );
            }
            if (!resultado.repetido) {
              await runStoreOp(() =>
                workOrders.appendEvent(associatedWoId, {
                  sourceId: actor,
                  sessionId: resultado.id,
                  idempotencyKey: `wo-child:${resultado.id}`,
                  type: "member.status",
                  provenance: "observed",
                  payload: {
                    memberId: resultado.memberId || null,
                    motor: resultado.motor,
                    modelo: resultado.modelo || null,
                    esfuerzo: resultado.esfuerzo || null,
                    role: resultado.role || null,
                    status: resultado.estado,
                    workspaceKind: resultado.workspaceKind || null,
                    enColaRecursos: Boolean(resultado.enColaRecursos),
                  },
                }),
              ).catch(() => {});
            }
          } else if (accion === "entregar" && associatedWoId && resultado?.id) {
            await runStoreOp(() =>
              workOrders.appendEvent(associatedWoId, {
                sourceId: resultado.memberId || actor,
                sessionId: sesion,
                idempotencyKey: `wo-artifact:${resultado.id}`,
                type: "artifact.published",
                provenance: "observed",
                payload: {
                  artifactId: resultado.id,
                  authorId: resultado.memberId || actor,
                  fileRef: resultado.ruta || `entregable/${resultado.id}`,
                  fileName: resultado.ruta
                    ? path.basename(resultado.ruta)
                    : resultado.titulo,
                  hash: resultado.sha256 || "",
                  version: resultado.version || 1,
                },
              }),
            ).catch(() => {});
          } else if (accion === "integrar" && associatedWoId && resultado) {
            await runStoreOp(() =>
              workOrders.appendEvent(associatedWoId, {
                sourceId: actor,
                sessionId: sesion,
                idempotencyKey: resultado.integracion?.id
                  ? `wo-integ:${resultado.integracion.id}`
                  : undefined,
                type: "member.status",
                provenance: "observed",
                payload: {
                  reason:
                    resultado.estado === "conflicto"
                      ? "integration_conflict"
                      : "integration_completed",
                  estado: resultado.estado,
                  conflictos: resultado.conflictos || [],
                  // Local paths stay in the lanzador; events carry hashes.
                  integrados: (resultado.integrados || []).map(
                    ({ destino: _destino, ...item }) => item,
                  ),
                },
              }),
            ).catch(() => {});
          }
          return send(response, 200, resultado);
        }
        if (
          policy &&
          !policy.query.safeParse(Object.fromEntries(consulta)).success
        )
          throw new Failure("Consulta inválida.");
        const relayArtifactDownload = async (res, upstream, meta = {}) => {
          const buf = Buffer.from(await upstream.arrayBuffer());
          const rawName = upstream.headers.get("x-artifact-filename");
          const fileName =
            meta.fileName ||
            (rawName ? decodeURIComponent(rawName) : "artifact.bin");
          res.writeHead(200, {
            ...downloadHeaders({ name: fileName, size: buf.length }),
            "X-Artifact-Id":
              upstream.headers.get("x-artifact-id") || meta.id || "",
            "X-Artifact-Version":
              upstream.headers.get("x-artifact-version") ||
              (meta.version !== undefined ? String(meta.version) : ""),
            "X-Artifact-Sha256":
              upstream.headers.get("x-artifact-sha256") || meta.sha256 || "",
            "X-Artifact-Author":
              upstream.headers.get("x-artifact-author") || meta.authorId || "",
            "X-Artifact-FileRef":
              upstream.headers.get("x-artifact-fileref") ||
              (meta.fileRef ? encodeURIComponent(meta.fileRef) : ""),
          });
          res.end(buf);
        };
        const routes = {
          "GET /health": async () => {
            const ready = await stat(path.join(root, "Home.md"))
              .then((s) => s.isFile())
              .catch(() => false);
            return send(response, ready ? 200 : 503, {
              status: ready ? "ready" : "unavailable",
              version: APP_VERSION,
              storage: "obsidian-markdown",
              maintenance: await operationalStatus({
                stateFile: "/var/lib/secondbrain-ops/backup-status.json",
                revisionFile: path.join(appRoot, "REVISION"),
                launcherPinFile: "/etc/secondbrain/launcher-release",
                runtimeLauncherFile: "/run/secondbrain-launcher-release",
              }),
            });
          },
          "GET /auth/status": async () => {
            return send(response, 200, {
              authenticated: auth.authenticated(request),
              enabled: auth.enabled,
              needsSetup: auth.enabled && !auth.state.passwordHash,
              // Display name only (SB_OWNER_NAME); empty keeps the UI neutral.
              ownerName: String(process.env.SB_OWNER_NAME ?? "")
                .trim()
                .slice(0, 60),
            });
          },
          "GET /auth/csrf": async () => {
            return send(response, 200, auth.csrf(request, response));
          },
          "POST /auth/setup": async () => {
            return send(
              response,
              200,
              await auth.setup(await body(request), request, response),
            );
          },
          "POST /auth/login": async () => {
            return send(
              response,
              200,
              await auth.login(await body(request), request, response),
            );
          },
          "GET /mundo/overview": async () => {
            return send(response, 200, await mundo.leer());
          },
          "GET /mundo/document": async () => {
            return send(
              response,
              200,
              await mundo.documento(consulta.get("path")),
            );
          },
          "GET /mundo/media": async () => {
            return await mundo.imagen(consulta.get("path"), response);
          },
          "POST /mundo/briefs": async () => {
            return send(
              response,
              201,
              await mundo.crearBrief(await body(request)),
            );
          },
          "POST /mundo/agents": async () => {
            return send(
              response,
              200,
              await mundo.configurarAgente(await body(request)),
            );
          },
          "POST /mundo/tasks": async () => {
            return send(
              response,
              201,
              await mundo.crearEncargo(await body(request)),
            );
          },
          "POST /mundo/tasks/status": async () => {
            return send(
              response,
              200,
              await mundo.cambiarEncargo(await body(request)),
            );
          },
          "GET /agentes/sesiones": async () => {
            const sesiones = await lanzador.leer();
            // Long transcripts are only read when a conversation is open; the
            // scene and the lists ask for this light version every few seconds.
            return send(
              response,
              200,
              consulta.has("resumen") && Array.isArray(sesiones)
                ? sesiones.map(({ mensajes: _m, resultado: _r, ...s }) => s)
                : sesiones,
            );
          },
          "GET /agentes/espacios": async () =>
            send(response, 200, await lanzador.espacios()),
          "POST /agentes/espacios": async () =>
            send(response, 200, await lanzador.espacios(await body(request))),
          "GET /agentes/conversacion/stream": async () =>
            routes["GET /agentes/terminal/stream"](),
          "GET /agentes/conversacion/artefactos/descargar": async () => {
            const upstream = await lanzador.descargarArtefacto(
              consulta.get("id"),
              consulta.get("artifactId"),
            );
            await relayArtifactDownload(response, upstream);
            return;
          },
          "POST /agentes/conversacion/responder": async () =>
            send(response, 200, await lanzador.responder(await body(request))),
          "GET /agentes/terminal/stream": async () => {
            // The launcher's SSE goes through untouched: no buffering, and
            // either side closing ends the other. The browser retries.
            const origen = new AbortController();
            const cortar = () => origen.abort();
            response.on("close", cortar);
            const upstream = await lanzador.flujo(
              consulta.get("id"),
              origen.signal,
              route === "/agentes/conversacion/stream",
            );
            response.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            response.flushHeaders?.();
            // A session that ends (logout, expiry) must not keep a stream open.
            const vigilar = setInterval(() => {
              if (!auth.authenticated(request)) origen.abort();
            }, 20000);
            vigilar.unref();
            try {
              for await (const chunk of upstream.body) {
                if (response.destroyed) break;
                if (!response.write(chunk)) await once(response, "drain");
              }
            } catch {
              /* either side closed */
            } finally {
              clearInterval(vigilar);
              response.off("close", cortar);
              origen.abort();
              response.end();
            }
          },
          "POST /agentes/terminal/entrada": async () =>
            send(response, 200, await lanzador.entrada(await body(request))),
          "GET /agentes/capacidades": async () =>
            send(response, 200, await lanzador.capacidades()),
          "GET /agentes/mi-capacidad": async () => {
            if (callerCap) {
              const { digest: _d, ...publicCap } = callerCap;
              return send(response, 200, { scoped: true, ...publicCap });
            }
            if (auth.isAgent(request)) {
              return send(response, 200, {
                scoped: false,
                unrestrictedLegacyRoom: true,
              });
            }
            return send(response, 200, { scoped: false, owner: true });
          },
          "POST /agentes/capacidades/token": async () => {
            if (!auth.isSupervisor(request)) {
              throw new Failure(
                "Solo el operador o supervisor puede emitir credenciales acotadas.",
                403,
              );
            }
            const data = await body(request);
            const prof = await resolveServerProfile(
              data.profileId || "investigacion",
              data.parentProfileId
                ? await resolveServerProfile(data.parentProfileId)
                : null,
            );
            const minted = await auth.issueCapability({
              sessionId: data.sessionId ?? null,
              parentSessionId: data.parentSessionId ?? null,
              workOrderId: data.workOrderId ?? null,
              memberId: data.memberId ?? null,
              actor: data.actor ?? null,
              profileId: prof.id,
              allowedMcps: prof.allowedMcps,
              allowedOperations: prof.allowedOperations,
              allowedEffectCategories: prof.allowedEffectCategories,
              allowBilledApi: false,
              canDelegateBeyondSelf: false,
              depth: data.parentSessionId ? 2 : 1,
              maxDepth: 2,
            });
            const { digest: _d, ...publicRec } = minted.record;
            return send(response, 201, {
              token: minted.token,
              capacidad: publicRec,
            });
          },
          "GET /agentes/herramientas/catalogo": async () =>
            send(
              response,
              200,
              await lanzador.catalogoHerramientas({
                motor: consulta.get("motor") ?? undefined,
                profileId: consulta.get("profileId") ?? undefined,
                parentProfileId: consulta.get("parentProfileId") ?? undefined,
                memberId: consulta.get("memberId") ?? undefined,
                sessionId: consulta.get("sessionId") ?? undefined,
                probe: consulta.get("probe") === "true" ? "true" : undefined,
              }),
            ),
          "POST /agentes/herramientas/perfiles": async () =>
            send(
              response,
              200,
              await lanzador.actualizarPerfilHerramientas(await body(request)),
            ),
          "POST /agentes/herramientas/skills/resolver": async () => {
            const payload = await body(request);
            const { billingAuthorized: _ignored, ...safePayload } = payload;
            return send(
              response,
              200,
              await lanzador.resolverSkills(safePayload),
            );
          },
          "GET /agentes/conversacion/cola": async () =>
            send(
              response,
              200,
              await lanzador.colaConversacion(consulta.get("id")),
            ),
          "POST /agentes/conversacion/mensajes": async () => {
            const payload = await body(request);
            const sent = await lanzador.enviarMensajeConversacion(payload);
            const link = sessionWorkOrderLinks.get(payload.id);
            if (link) {
              bridgeSessionToWorkOrder(
                payload.id,
                link.workOrderId,
                link.fallbackMemberId,
              );
            }
            return send(response, 200, sent);
          },
          "POST /agentes/conversacion/cola/cancelar": async () =>
            send(
              response,
              200,
              await lanzador.cancelarColaConversacion(await body(request)),
            ),
          "GET /agentes/sesiones/diff": async () =>
            send(
              response,
              200,
              await lanzador.diff({
                id: consulta.get("id"),
                desde: consulta.get("desde") ?? undefined,
                hasta: consulta.get("hasta") ?? undefined,
              }),
            ),
          "GET /agentes/sesiones/pr/propuesta": async () =>
            send(response, 200, await lanzador.propuestaPr(consulta.get("id"))),
          "POST /agentes/sesiones/revertir": async () =>
            send(response, 200, await lanzador.revertir(await body(request))),
          "POST /agentes/sesiones/pr": async () =>
            send(response, 200, await lanzador.pr(await body(request))),
          "POST /agentes/sesiones/pr/redactar": async () =>
            send(
              response,
              200,
              await lanzador.redactarPr((await body(request)).id),
            ),
          "GET /agentes/proyectos-lanzador": async () => {
            return send(response, 200, await lanzador.proyectos());
          },
          "GET /agentes/modelos-lanzador": async () => {
            return send(response, 200, await lanzador.modelos());
          },
          "GET /agentes/uso": async () =>
            send(response, 200, await lanzador.uso()),
          "POST /agentes/sesiones": async () => {
            const payload = await body(request);
            if (payload.continuar) {
              const { billingAuthorized: _ignored, ...safeCont } = payload;
              const session = await lanzador.encargar(safeCont);
              return send(response, 202, session);
            }
            const billingGrantVerified = hasVerifiedBillingGrant({
              billingApprovalId: payload.billingApprovalId,
              fromAgent: false,
            });
            if (
              payload.motor === "deepseek" &&
              !billingGrantVerified &&
              process.env.SB_ALLOW_BILLED_DEEPSEEK !== "1"
            ) {
              throw new Failure(
                "DeepSeek bloqueado por la política de gasto sin autorización verificada de gasto.",
                403,
              );
            }
            let parentCoordProfile = null;
            let memberAssignedProfileId = payload.toolProfileId || "ejecucion";
            let manifestFields = {};
            if (payload.workOrderId) {
              const wo = workOrders.get(payload.workOrderId);
              if (!wo) throw new Failure("Encargo no encontrado.", 404);
              // A started work order fixes model, effort and role from its
              // frozen manifest; a draft keeps the single-agent F2 path, and
              // its sessions cannot delegate until the order is started.
              if (wo.manifest)
                manifestFields = {
                  manifest: wo.manifest,
                  manifestSha256: wo.manifest.sha256,
                };
              {
                const coord = wo.team?.find((m) => m.coordinator);
                if (coord?.toolProfileId) {
                  parentCoordProfile = await resolveServerProfile(
                    coord.toolProfileId,
                  );
                }
                const targetMember = payload.memberId
                  ? wo.team?.find(
                      (m) =>
                        m.id === payload.memberId ||
                        m.characterId === payload.memberId,
                    )
                  : null;
                if (targetMember?.toolProfileId) {
                  memberAssignedProfileId = payload.toolProfileId
                    ? (
                        await resolveServerProfile(
                          payload.toolProfileId,
                          await resolveServerProfile(
                            targetMember.toolProfileId,
                          ),
                        )
                      ).id
                    : targetMember.toolProfileId;
                }
              }
            }
            const requestedProfile = await resolveServerProfile(
              memberAssignedProfileId,
              parentCoordProfile,
            );
            if (options.operatorToolPolicy?.allowedOperations) {
              requestedProfile.allowedOperations = intersectList(
                requestedProfile.allowedOperations,
                options.operatorToolPolicy.allowedOperations,
              );
            }
            if (options.operatorToolPolicy?.allowedMcps) {
              requestedProfile.allowedMcps = intersectList(
                requestedProfile.allowedMcps,
                options.operatorToolPolicy.allowedMcps,
              );
            }
            const preassignedSessionId = randomUUID();
            const sessionActor = MOTOR_ACTOR[payload.motor] || null;
            const minted = await auth.issueCapability({
              sessionId: preassignedSessionId,
              workOrderId: payload.workOrderId ?? null,
              memberId:
                payload.memberId || sessionActor || preassignedSessionId,
              actor: sessionActor,
              profileId: requestedProfile.id,
              allowedMcps: requestedProfile.allowedMcps,
              allowedOperations: requestedProfile.allowedOperations,
              allowedEffectCategories: requestedProfile.allowedEffectCategories,
              allowBilledApi: Boolean(billingGrantVerified),
              canDelegateBeyondSelf: false,
              depth: 1,
              maxDepth: 2,
            });
            let session;
            try {
              const { billingAuthorized: _ignoredBilling, ...restPayload } =
                payload;
              session = await lanzador.encargar({
                ...restPayload,
                ...manifestFields,
                id: preassignedSessionId,
                toolProfileId: requestedProfile.id,
                effectiveProfile: requestedProfile,
                capabilityToken: minted.token,
                billingGrantVerified,
                billingAuthorized: Boolean(billingGrantVerified),
              });
              if (session?.id && session.id !== preassignedSessionId) {
                await auth.bindCapabilitySession(minted.record.id, session.id, {
                  rebind: true,
                });
              }
            } catch (err) {
              await auth.revokeCapability({ tokenId: minted.record.id });
              throw err;
            }
            const targetWo = payload.workOrderId || session?.workOrderId;
            if (session?.structured && targetWo && session?.id) {
              bridgeSessionToWorkOrder(
                session.id,
                targetWo,
                session.memberId || payload.memberId || session.motor,
              );
            }
            if (targetWo && session?.id) {
              await runStoreOp(() =>
                workOrders.appendEvent(targetWo, {
                  sourceId:
                    session.memberId || payload.memberId || actorOf(request),
                  sessionId: session.id,
                  idempotencyKey: `wo-session:${session.id}`,
                  type: "member.status",
                  provenance: "observed",
                  payload: {
                    memberId: session.memberId || null,
                    motor: session.motor,
                    modelo: session.modelo || null,
                    esfuerzo: session.esfuerzo || null,
                    role: session.role || null,
                    status: session.estado,
                    workspaceKind: session.workspaceKind || null,
                    enColaRecursos: Boolean(session.enColaRecursos),
                  },
                }),
              ).catch(() => {});
            }
            return send(response, 202, session);
          },
          "POST /agentes/sesiones/cancelar": async () => {
            return send(
              response,
              202,
              await lanzador.cancelar((await body(request)).id),
            );
          },
          "POST /agentes/sesiones/eliminar": async () => {
            const targetId = (await body(request)).id;
            const out = await lanzador.eliminar(targetId);
            await auth.revokeCapability({ sessionId: targetId });
            return send(response, 200, out);
          },
          "GET /sala": async () => {
            return send(
              response,
              200,
              sala.leer(consulta.get("espacio") ?? undefined),
            );
          },
          "POST /sala/tablero": async () => {
            return send(response, 200, await sala.guardar(await body(request)));
          },
          "POST /sala/encargos": async () => {
            return send(
              response,
              200,
              await sala.encargar(await body(request)),
            );
          },
          "POST /sala/agentes": async () => {
            // Retired: the room has four fixed agents. The body is still
            // validated so a malformed request keeps answering 400, not 410.
            await body(request);
            return send(response, 201, await sala.crearAgente());
          },
          "POST /sala/agentes/borrar": async () => {
            return send(
              response,
              200,
              await sala.borrarAgente(await body(request)),
            );
          },
          "GET /sala/imagen": async () => {
            return await sala.imagen(
              new URL(request.url, "http://localhost").searchParams.get("id"),
              response,
            );
          },
          "GET /vault/files": async () => {
            return send(response, 200, await vault.files());
          },
          "GET /vault/note": async () => {
            const relative = consulta.get("path");
            validateNotePath(relative);
            await vault.queue;
            const content = await readFile(await vault.safe(relative), "utf8");
            return send(response, 200, {
              path: relative,
              content,
              hash: hash(content),
            });
          },
          "POST /vault/note": async () => {
            const {
              path: relative,
              content,
              expectedHash,
            } = await body(request);
            validateNotePath(relative);
            // Every agent reads these first; a rewrite would steer all of them.
            if (
              auth.isRoomAgent(request) &&
              /^(AGENTS\.md$|99-Meta\/)/.test(path.posix.normalize(relative))
            )
              throw new Failure(
                "Las reglas del vault solo las edita su dueño.",
                403,
              );
            if (relative.split("/").pop() === "Datos-financieros.md")
              throw new Failure(
                "Usa las operaciones de finanzas para los datos estructurados.",
              );
            if (
              typeof content !== "string" ||
              Buffer.byteLength(content) > 2 * 1024 * 1024 ||
              (expectedHash !== null &&
                !/^[a-f0-9]{64}$/.test(expectedHash || ""))
            )
              throw new Failure(
                "Envía el contenido y el hash leído; null solo para notas nuevas.",
              );
            await vault.exclusive(() =>
              vault.transaction(() =>
                vault.atomic(relative, content, expectedHash),
              ),
            );
            change();
            return send(response, 200, { path: relative, hash: hash(content) });
          },
          "POST /auth/logout": async () => {
            await auth.logout(request, response);
            return send(response, 204);
          },
          "POST /auth/totp/start": async () => {
            return send(response, 200, await auth.startTotp());
          },
          "POST /auth/totp/enable": async () => {
            return send(
              response,
              200,
              await auth.enableTotp((await body(request)).code),
            );
          },
          "GET /vault/status": async () => {
            const snapshot = await vault.read();
            return send(response, 200, {
              root,
              source: "Obsidian · Markdown",
              documents: snapshot.byPath.size,
              issues: snapshot.issues,
            });
          },
          "GET /items": async () => {
            const snapshot = await vault.read();
            return await sendItems(request, response, [
              ...snapshot.items,
              ...reminders(snapshot.items),
            ]);
          },
          "POST /mutations": async () => {
            const result = await vault.mutate(await body(request));
            change();
            return send(response, 200, result);
          },
          "POST /imports": async () => {
            const result = await vault.import((await body(request)).items);
            change();
            return send(response, 200, result);
          },
          "GET /export": async () => {
            const snapshot = await vault.read();
            /** @type {Record<string, Uint8Array>} */
            const files = {};
            const manifest = [];
            for (const record of snapshot.byPath.values()) {
              files[record.relative] = strToU8(record.text);
              manifest.push({
                path: record.relative,
                sha256: hash(record.text),
              });
            }
            files["second-brain-vault.json"] = strToU8(
              JSON.stringify(
                {
                  schemaVersion: 2,
                  source: "obsidian-markdown",
                  exportedAt: new Date().toISOString(),
                  files: manifest,
                },
                null,
                2,
              ),
            );
            const archive = await new Promise((resolve, reject) =>
              zip(files, (error, archive) =>
                error ? reject(error) : resolve(archive),
              ),
            );
            response.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Disposition":
                'attachment; filename="second-brain-vault.zip"',
            });
            response.end(archive);
            return;
          },
          "GET /finance/overview": async () => {
            return send(response, 200, await finance.overview(mexicoDay()));
          },
          "POST /finance/ops": async () => {
            const operacion = await body(request);
            const previous = await finance.previous(operacion);
            if (previous) return send(response, 200, previous);
            await finance.validate(operacion, mexicoDay());
            let aprobacionId;
            if (auth.isRoomAgent(request)) {
              const solicitud = await aprobaciones.solicitar({
                actor: actorOf(request),
                operacion,
              });
              aprobacionId = solicitud.id;
              if ((await solicitud.esperar) !== "aprobada")
                throw new Failure("La operación no fue aprobada.", 403);
            }
            let result;
            try {
              result = await finance.run(operacion, mexicoDay());
            } catch (error) {
              if (aprobacionId)
                await aprobaciones.finalizar(
                  aprobacionId,
                  "No aplicada: la operación no se pudo guardar.",
                );
              throw error;
            }
            if (aprobacionId)
              await aprobaciones.finalizar(
                aprobacionId,
                "Aplicada: la operación se guardó.",
              );
            change();
            return send(response, 200, result);
          },
          "GET /oauth/clientes": async () =>
            send(response, 200, mcpRemoto.listar()),
          "POST /oauth/clientes/revocar": async () => {
            await mcpRemoto.revocar((await body(request)).id);
            return send(response, 200, { ok: true });
          },
          "GET /aprobaciones": async () =>
            send(response, 200, aprobaciones.listar()),
          "POST /aprobaciones/decidir": async () => {
            const { id, aprobar, requestId } = await body(request);
            let resultado;
            try {
              resultado = await aprobaciones.decidir(id, aprobar, {
                requestId,
                por: auth.state?.username || actorOf(request),
              });
            } catch (error) {
              if (error instanceof ConflictoAprobacion)
                throw Object.assign(new Failure(error.message, 409), {
                  recibo: error.recibo,
                });
              throw new Failure("Solicitud no pendiente o expirada.", 409);
            }
            return send(response, 200, { ok: true, ...resultado });
          },
          "GET /encargos": async () =>
            send(response, 200, { encargos: workOrders.list() }),
          "GET /encargos/detalle": async () => {
            const id = consulta.get("id");
            const rawCursor = consulta.get("cursor");
            const cursor = rawCursor !== null ? Number(rawCursor) : 0;
            const recipientScope = consulta.get("recipientScope") || undefined;
            const requestedMemberId = consulta.get("memberId") || undefined;
            const wo = workOrders.get(id);
            if (!wo) throw new Failure("Encargo no encontrado.", 404);
            if (callerCap?.workOrderId && callerCap.workOrderId !== id) {
              throw new Failure(
                "Encargo fuera de alcance de tu credencial.",
                403,
              );
            }
            /** @type {{ cursor: number, recipientScope?: string, memberId?: string }} */
            let feedArgs = {
              cursor,
              recipientScope,
              memberId: requestedMemberId,
            };
            if (auth.isRoomAgent(request)) {
              const { agentId } = agentHeaders(request);
              const authIdentity =
                callerCap?.memberId || callerCap?.actor || agentId;
              const matched = authIdentity
                ? wo.team.find((m) =>
                    requestedMemberId
                      ? m.id === requestedMemberId &&
                        (m.characterId === authIdentity ||
                          m.id === authIdentity ||
                          (callerCap?.actor &&
                            m.characterId === callerCap.actor))
                      : m.characterId === authIdentity ||
                        m.id === authIdentity ||
                        (callerCap?.actor && m.characterId === callerCap.actor),
                  )
                : null;
              feedArgs =
                recipientScope === "equipo" || !matched
                  ? { cursor, recipientScope: "equipo" }
                  : { cursor, memberId: matched.id };
            }
            const detalle = await runStoreOp(() =>
              workOrders.getSnapshotAndFeed(id, feedArgs),
            );
            if (!detalle) throw new Failure("Encargo no encontrado.", 404);
            return send(response, 200, detalle);
          },
          "GET /encargos/artefactos/descargar": async () => {
            const workOrderId = consulta.get("workOrderId");
            const artifactId = consulta.get("artifactId");
            const wo = workOrders.get(workOrderId);
            if (!wo) throw new Failure("Encargo no encontrado.", 404);
            if (
              callerCap?.workOrderId &&
              callerCap.workOrderId !== workOrderId
            ) {
              throw new Failure("Acceso de encargo no autorizado.", 403);
            }
            if (auth.isRoomAgent(request)) {
              const { agentId } = agentHeaders(request);
              const authIdentity =
                callerCap?.memberId || callerCap?.actor || agentId;
              const member = authIdentity
                ? wo.team.find(
                    (m) =>
                      m.characterId === authIdentity ||
                      m.id === authIdentity ||
                      (callerCap?.actor && m.characterId === callerCap.actor),
                  )
                : null;
              if (!member)
                throw new Failure("Acceso de encargo no autorizado.", 403);
            }
            const art = (wo.artifacts || []).find((a) => a.id === artifactId);
            if (!art || !art.sessionId) {
              throw new Failure("Artefacto no encontrado.", 404);
            }
            const upstream = await lanzador.descargarArtefacto(
              art.sessionId,
              artifactId,
            );
            await relayArtifactDownload(response, upstream, art);
            return;
          },
          "POST /encargos": async () => {
            const data = await body(request);
            const encargo = await runStoreOp(() =>
              workOrders.createWorkOrder(data),
            );
            return send(response, 201, { ok: true, encargo });
          },
          "POST /encargos/equipo": async () => {
            const data = await body(request);
            const encargo = await runStoreOp(() =>
              workOrders.updateTeam(data.workOrderId, data),
            );
            return send(response, 200, { ok: true, encargo });
          },
          "POST /encargos/iniciar": async () => {
            const { workOrderId, expectedRevision } = await body(request);
            const encargo = await runStoreOp(() =>
              workOrders.startWorkOrder(workOrderId, { expectedRevision }),
            );
            return send(response, 200, { ok: true, encargo });
          },
          "POST /encargos/mensajes": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              workOrders.enqueueMessage(data.workOrderId, data),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /encargos/eventos": async () => {
            const data = await body(request);
            const { agentId, sessionUuid } = agentHeaders(request);
            const resultado = await runStoreOp(() =>
              workOrders.appendEvent(data.workOrderId, {
                ...data,
                sourceId:
                  data.sourceId ||
                  (auth.isRoomAgent(request) && agentId
                    ? agentId
                    : actorOf(request)),
                sessionId: data.sessionId ?? sessionUuid,
              }),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /encargos/handoffs": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              workOrders.createHandoff(data.workOrderId, data),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /encargos/verificar": async () => {
            const data = await body(request);
            const encargo = await runStoreOp(() =>
              workOrders.verifyWorkOrder(data.workOrderId, {
                ...data,
                actor: auth.state?.username || actorOf(request),
              }),
            );
            return send(response, 200, { ok: true, encargo });
          },
          "POST /encargos/integrar": async () => {
            const data = await body(request);
            const sesionObj = (await sesionesLanzador()).find(
              (s) => s.id === data.sesion,
            );
            if (!sesionObj) throw new Failure("Sesión no activa.", 403);
            const actor = {
              claude: "ambar",
              codex: "menta",
              agy: "lira",
              deepseek: "marina",
            }[sesionObj.motor];
            const resultado = await lanzador.equipo(
              "integrar",
              data.sesion,
              actor,
              {
                entregableIds: data.entregableIds,
                resoluciones: data.resoluciones,
                targetDir: data.targetDir,
              },
            );
            const targetWo = data.workOrderId || sesionObj.workOrderId;
            if (targetWo && workOrders.get(targetWo)) {
              await runStoreOp(() =>
                workOrders.appendEvent(targetWo, {
                  sourceId: actorOf(request),
                  sessionId: data.sesion,
                  idempotencyKey: resultado.integracion?.id
                    ? `wo-integ:${resultado.integracion.id}`
                    : undefined,
                  type: "member.status",
                  provenance: "observed",
                  payload: {
                    reason:
                      resultado.estado === "conflicto"
                        ? "integration_conflict"
                        : "integration_completed",
                    estado: resultado.estado,
                    conflictos: resultado.conflictos || [],
                    // Local paths stay in the lanzador; events carry hashes.
                    integrados: (resultado.integrados || []).map(
                      ({ destino: _destino, ...item }) => item,
                    ),
                  },
                }),
              ).catch(() => {});
            }
            return send(response, 200, resultado);
          },
          "GET /solicitudes": async () => {
            const items = userRequests.list({
              workOrderId: consulta.get("workOrderId") || undefined,
              kind: consulta.get("kind") || undefined,
              status: consulta.get("status") || undefined,
            });
            return send(response, 200, {
              solicitudes: auth.isAgent(request)
                ? items.filter((item) =>
                    canAgentAccessScopedRecord(request, item),
                  )
                : items,
            });
          },
          "GET /solicitudes/detalle": async () => {
            const solicitud = userRequests.get(consulta.get("id"));
            if (!solicitud) throw new Failure("Solicitud no encontrada.", 404);
            if (
              auth.isAgent(request) &&
              !canAgentAccessScopedRecord(request, solicitud)
            ) {
              throw new Failure(
                "No puedes consultar solicitudes ni aprobaciones de otro miembro.",
                403,
              );
            }
            return send(response, 200, { solicitud });
          },
          "POST /solicitudes/preguntar": async () => {
            const data = await body(request);
            const { agentId, sessionUuid } = agentHeaders(request);
            if (
              callerCap?.workOrderId &&
              data.workOrderId &&
              data.workOrderId !== callerCap.workOrderId
            ) {
              throw new Failure(
                "Encargo fuera de alcance de tu credencial.",
                403,
              );
            }
            const resultado = await runStoreOp(() =>
              userRequests.createRequest({
                id: data.id,
                createRequestId: data.requestId,
                workOrderId: callerCap?.workOrderId ?? data.workOrderId,
                sessionId:
                  callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
                memberId:
                  callerCap?.memberId ??
                  callerCap?.actor ??
                  data.memberId ??
                  agentId,
                title: data.titulo ?? data.title,
                prompt: data.pregunta ?? data.prompt,
                options: data.opciones ?? data.options,
                allowFreeText: data.permiteTextoLibre ?? data.allowFreeText,
                nativeRequestId: data.nativeRequestId,
                nativeSessionId: data.nativeSessionId,
                nativeTurnId: data.nativeTurnId,
                ttlMs: data.ttlMs,
                kind: "question",
              }),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /solicitudes/esperar": async () => {
            const { id, timeout = 240_000 } = await body(request);
            const existing = userRequests.get(id);
            if (
              existing &&
              auth.isAgent(request) &&
              !canAgentAccessScopedRecord(request, existing)
            ) {
              throw new Failure(
                "Solicitud fuera de alcance de tu sesión.",
                403,
              );
            }
            const solicitud = await runStoreOp(() =>
              userRequests.waitForResponse(id, { timeoutMs: timeout }),
            );
            return send(response, 200, { ok: true, solicitud });
          },
          "POST /solicitudes/aprobacion": async () => {
            const data = await body(request);
            const { agentId, sessionUuid } = agentHeaders(request);
            if (
              callerCap?.workOrderId &&
              data.workOrderId &&
              data.workOrderId !== callerCap.workOrderId
            ) {
              throw new Failure(
                "Encargo fuera de alcance de tu credencial.",
                403,
              );
            }
            const resultado = await runStoreOp(() =>
              userRequests.createRequest({
                ...data,
                createRequestId: data.requestId,
                workOrderId: callerCap?.workOrderId ?? data.workOrderId,
                sessionId:
                  callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
                memberId:
                  callerCap?.memberId ??
                  callerCap?.actor ??
                  data.memberId ??
                  agentId,
                kind: "approval",
              }),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /solicitudes/responder": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              userRequests.respond(data.id, {
                ...data,
                by: auth.state?.username || actorOf(request),
                origin: data.origin || "app",
              }),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /solicitudes/cerrar-turno": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              userRequests.markTurnClosed(data),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /solicitudes/verificar-ejecucion": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              userRequests.verifyApprovalBeforeExecute(data.id, data),
            );
            return send(response, 200, { ok: true, ...resultado });
          },
          "POST /solicitudes/entrega": async () => {
            const data = await body(request);
            const solicitud = await runStoreOp(() =>
              userRequests.updateDeliveryState(data.id, data),
            );
            return send(response, 200, { ok: true, solicitud });
          },
          "GET /efectos": async () => {
            const items = effects.list({
              workOrderId: consulta.get("workOrderId") || undefined,
              status: consulta.get("status") || undefined,
              includeSensitive: true,
            });
            return send(response, 200, {
              operaciones: auth.isAgent(request)
                ? items.filter((op) => canAgentAccessScopedRecord(request, op))
                : items,
            });
          },
          "GET /efectos/detalle": async () => {
            const operacion = effects.get(consulta.get("id"), {
              includeSensitive: true,
            });
            if (!operacion) {
              throw new Failure("Operación protegida no encontrada.", 404);
            }
            if (
              auth.isAgent(request) &&
              !canAgentAccessScopedRecord(request, operacion)
            ) {
              throw new Failure(
                "No puedes inspeccionar contenido sensible de efectos de otro miembro.",
                403,
              );
            }
            return send(response, 200, { operacion });
          },
          "POST /efectos/preparar": async () => {
            const data = await body(request);
            const { agentId, sessionUuid } = agentHeaders(request);
            const isAgentCall = auth.isAgent(request);
            if (
              callerCap?.workOrderId &&
              data.workOrderId &&
              data.workOrderId !== callerCap.workOrderId
            ) {
              throw new Failure(
                "Encargo fuera de alcance de tu credencial.",
                403,
              );
            }
            const resolvedMemberId =
              callerCap?.memberId ??
              callerCap?.actor ??
              data.memberId ??
              agentId;
            const resolvedWorkOrderId =
              callerCap?.workOrderId ?? data.workOrderId;
            let resolvedProfile = callerCap?.profileId ?? data.toolProfileId;
            let allowedCategoriesOverride = callerCap
              ? callerCap.allowedEffectCategories
              : undefined;
            if (
              !callerCap &&
              resolvedWorkOrderId &&
              auth.isRoomAgent(request)
            ) {
              const wo = workOrders.get(resolvedWorkOrderId);
              const member = wo?.team?.find(
                (m) =>
                  m.id === resolvedMemberId ||
                  (agentId && m.characterId === agentId),
              );
              if (member?.toolProfileId) {
                resolvedProfile = member.toolProfileId;
              }
            }
            const { billingAuthorized: _ignoredClientBilling, ...safeData } =
              data;
            const resultado = await runStoreOp(() =>
              effects.prepareEffect({
                ...safeData,
                fromAgent: isAgentCall,
                workOrderId: resolvedWorkOrderId,
                memberId: resolvedMemberId,
                sessionId:
                  callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
                toolProfileId: resolvedProfile,
                ...(allowedCategoriesOverride !== undefined
                  ? { allowedCategoriesOverride }
                  : {}),
              }),
            );
            return send(response, 201, { ok: true, ...resultado });
          },
          "POST /efectos/ejecutar": async () => {
            const data = await body(request);
            if (auth.isAgent(request)) {
              const targetOp = effects.get(data.id, {
                includeSensitive: false,
              });
              if (targetOp && !canAgentAccessScopedRecord(request, targetOp)) {
                throw new Failure(
                  "No puedes ejecutar efectos preparados por otro miembro o sesión.",
                  403,
                );
              }
            }
            const resultado = await runStoreOp(() =>
              effects.executeEffect(data.id, {
                ...data,
                actor: auth.state?.username || actorOf(request),
              }),
            );
            return send(response, 200, resultado);
          },
          "POST /efectos/conciliar": async () => {
            const data = await body(request);
            const resultado = await runStoreOp(() =>
              effects.reconcileEffect(data.id, {
                ...data,
                actor: auth.state?.username || actorOf(request),
              }),
            );
            return send(response, 200, resultado);
          },
          "GET /finance/ledger": async () => {
            return send(response, 200, await vault.ledger());
          },
          "GET /files": async () => {
            return send(response, 200, {
              files: await shared.list(),
              trash: await shared.list({ trashed: true }),
            });
          },
          "GET /files/download": async () => {
            const { entry, file } = await shared.find(consulta.get("id"));
            // Open before writing the head: a vanished file is a clean 404, not a crash.
            const handle = await open(file, "r").catch((e) => {
              if (e.code === "ENOENT")
                throw new Failure("Archivo no encontrado.", 404);
              throw e;
            });
            response.writeHead(200, downloadHeaders(entry));
            try {
              await pipeline(
                handle.createReadStream({ autoClose: true }),
                response,
              );
            } catch (e) {
              // Headers are already out: the best left is to cut the connection.
              logger({
                event: "http.stream",
                requestId: response.getHeader("X-Request-Id"),
                type: e.name || "Error",
                message: String(e.message ?? e),
              });
              response.destroy();
            }
            return;
          },
          "GET /files/chunk": async () => {
            const integer = (name, fallback, min, max) => {
              const raw = consulta.get(name);
              if (raw === null || raw === "") return fallback;
              const n = Number(raw);
              if (!Number.isSafeInteger(n) || n < min || n > max)
                throw new Failure(
                  `«${name}» debe ser un entero entre ${min} y ${max}.`,
                );
              return n;
            };
            const length = integer("length", 262144, 1, 1024 * 1024);
            const offset = integer("offset", 0, 0, Number.MAX_SAFE_INTEGER);
            const part = await shared.chunk(consulta.get("id"), offset, length);
            return send(response, 200, {
              ...part.entry,
              offset: part.offset,
              bytes: part.bytes,
              next:
                part.offset + part.bytes < part.entry.size
                  ? part.offset + part.bytes
                  : null,
              base64: part.buffer.toString("base64"),
            });
          },
          "POST /files": async () => {
            const input = await body(request);
            const room = auth.isRoomAgent(request);
            if (room && input.area !== "de-agentes")
              throw new Failure(
                "Las agentes solo pueden subir a «de-agentes».",
                403,
              );
            const entry = await shared.put({
              area: input.area,
              name: input.name,
              note: input.note,
              actor: actorOf(request),
              buffer: Buffer.from(input.content, input.encoding),
            });
            return send(response, 201, entry);
          },
          "POST /files/raw": async () => {
            if (
              auth.isRoomAgent(request) &&
              consulta.get("area") !== "de-agentes"
            )
              throw new Failure(
                "Las agentes solo pueden subir a «de-agentes».",
                403,
              );
            const entry = await shared.putStream({
              area: consulta.get("area"),
              name: consulta.get("name"),
              note: consulta.get("note"),
              actor: actorOf(request),
              stream: request,
            });
            return send(response, 201, entry);
          },
          "POST /files/trash": async () => {
            const { id } = await body(request);
            return send(
              response,
              200,
              await shared.trash(id, {
                onlyArea: auth.isRoomAgent(request) ? "de-agentes" : undefined,
              }),
            );
          },
          "POST /files/restore": async () => {
            return send(
              response,
              200,
              await shared.restore((await body(request)).id),
            );
          },
          "POST /files/pin": async () => {
            const { id, pinned } = await body(request);
            return send(response, 200, await shared.pin(id, pinned));
          },
          "GET /events": async () => {
            response.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            response.write(": connected\n\n");
            clients.add(response);
            const heartbeat = setInterval(() => {
              if (!auth.authenticated(request)) {
                clearInterval(heartbeat);
                clients.delete(response);
                response.end();
              } else response.write(": heartbeat\n\n");
            }, 20000);
            heartbeat.unref();
            request.on("close", () => {
              clearInterval(heartbeat);
              clients.delete(response);
            });
            return;
          },
        };
        const handler = routes[method + " " + route];
        if (handler) return await handler();
        throw new Failure("Ruta de API no encontrada.", 404);
      }
      if (
        options.serveDashboard === false ||
        process.env.SERVE_DASHBOARD === "off"
      )
        throw new Failure(
          "Interfaz desactivada; el servicio de conocimiento sigue disponible.",
          404,
        );
      if (!["GET", "HEAD"].includes(request.method))
        throw new Failure("Método no permitido.", 405);
      const staticRoot = path.resolve(
        options.staticRoot ||
          process.env.WEB_ROOT ||
          path.join(appRoot, "dashboard", "dist"),
      );
      let relative;
      try {
        relative = decodeURIComponent(pathname);
      } catch {
        throw new Failure("Ruta inválida.");
      }
      if (
        relative.includes("\\") ||
        relative.split("/").some((p) => p === ".." || p.startsWith("."))
      )
        throw new Failure("Ruta inválida.", 403);
      let target = path.join(
        staticRoot,
        relative === "/" ? "index.html" : relative,
      );
      try {
        const real = await realpath(target);
        if (!real.startsWith(staticRoot + path.sep))
          throw new Failure("Ruta inválida.", 403);
        if (!(await stat(target)).isFile())
          throw Object.assign(new Error(), { code: "ENOENT" });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        if (path.extname(relative))
          throw new Failure("Archivo no disponible.", 404);
        target = path.join(staticRoot, "index.html");
      }
      const data = await readFile(target);
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
      };
      response.writeHead(200, {
        "Content-Type":
          (types[path.extname(target)] || "application/octet-stream") +
          "; charset=utf-8",
        "Cache-Control":
          path.basename(target) === "index.html" ||
          path.basename(target) === "sw.js"
            ? "no-cache"
            : "public, max-age=3600",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!error.status)
        logger({
          event: "http.error",
          requestId,
          type: error.name || "Error",
          message: String(error.message ?? error),
          stack: error.stack,
        });
      if (!response.headersSent)
        send(response, error.status || 500, {
          error: error.status
            ? error.message
            : "No se pudo completar la operación. El archivo original se conserva.",
          code: error.code,
          server: error.server,
          ...(error.recibo ? { recibo: error.recibo } : {}),
          ...(error.solicitud ? { solicitud: error.solicitud } : {}),
          ...(error.snapshot ? { snapshot: error.snapshot } : {}),
          ...(error.operacion ? { operacion: error.operacion } : {}),
        });
      else response.end();
    }
  };
  const server = http.createServer((request, response) =>
    actorContext.run(actorOf(request), () => handle(request, response)),
  );
  // Node's 5-minute default would cut large Maletín uploads on a slow uplink.
  server.requestTimeout = 30 * 60 * 1000;
  servidorHttp = server;
  const maintenance = setInterval(() => {
    auth.prune();
    history.prune().catch((error) =>
      logger({
        event: "http.error",
        type: error.name,
        message: error.message,
        stack: error.stack,
      }),
    );
  }, 86400000);
  maintenance.unref();
  const close = async () => {
    closed = true;
    clearInterval(maintenance);
    followUpTurns.clear();
    for (const c of activeSessionBridges.values()) c.abort();
    activeSessionBridges.clear();
    await aprobaciones.cerrar();
    await effects.close();
    await userRequests.cerrar();
    await workOrders.close();
    stopLanzadorEvents();
    for (const watcher of watchers) watcher.close();
    clearTimeout(changeTimer);
    for (const client of clients) client.end();
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
  };
  return {
    server,
    vault,
    finance,
    auth,
    workOrders,
    userRequests,
    effects,
    root,
    dataDirectory,
    close,
  };
}
/** Field paths and zod messages only: never the submitted values. */
function summarizeIssues(issues) {
  const shown = issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(raíz)"} (${i.message})`);
  return shown.join("; ") + (issues.length > 5 ? "; …" : ".");
}
function reminders(items) {
  const now = Date.now();
  return items
    .filter(
      (i) =>
        !i.deleted &&
        !["done", "cancelled"].includes(i.status) &&
        ["task", "event", "obligation", "statement"].includes(i.kind),
    )
    .flatMap((i) => {
      const instant = i.startsAt
        ? Date.parse(i.startsAt) - 15 * 60000
        : Date.parse(
            (i.kind === "statement" ? i.dueDate : i.date) + "T09:00:00-06:00",
          );
      if (
        !Number.isFinite(instant) ||
        instant > now ||
        instant < now - 2 * 86400000
      )
        return [];
      return [
        {
          id: stableId("notice:" + i.id + ":" + instant),
          kind: "notification",
          title: i.title,
          body: "Este compromiso del vault necesita atención.",
          source: i.id,
          status: "unread",
          version: 0,
          createdAt: new Date(instant).toISOString(),
          updatedAt: i.updatedAt,
        },
      ];
    });
}
export async function startService() {
  const releaseInstance = await acquireInstance(
    process.env.DATA_DIR || path.join(appRoot, ".data"),
  );
  let app;
  try {
    app = await createApplication();
  } catch (error) {
    await releaseInstance();
    throw error;
  }
  const port = Number(process.env.API_PORT || process.env.PORT || 5080);
  const host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () =>
    console.log(
      `Second Brain · http://${host}:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port} · vault ${app.root}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      await releaseInstance();
      process.exit(0);
    });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await startService();
