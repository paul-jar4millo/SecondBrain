// Everything the API routes share: stores, clients and the helpers that
// need them. createApplication builds it once and the routes receive it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readFileSync, watch } from "node:fs";
import { Vault, discoverVault, Failure } from "../vault.mjs";
import { History } from "../history.mjs";
import {
  SERVICE_TOOL_PROFILES,
  intersectProfileBounds,
} from "../agent-profiles.mjs";
import { DomainError } from "../domain-error.mjs";
import { GitHistory } from "../vault-git.mjs";
import { Auth } from "../auth.mjs";
import { Finance } from "../finance.mjs";
import { createRoom } from "../room.mjs";
import { createWorld } from "../world.mjs";
import { createLauncherClient } from "../launcher-client.mjs";
import { createRemoteMcp } from "../remote-mcp.mjs";
import { createApprovalQueue } from "../approvals.mjs";
import { createSharedFiles } from "../shared-files.mjs";
import { createWorkOrderStore } from "../work-orders.mjs";
import { createUserRequestStore } from "../user-requests.mjs";
import { createEffectsExecutor } from "../effects-executor.mjs";
import { createSessionBridges } from "../agent-bridges.mjs";
import { agentHeaders } from "./io.mjs";

/** @import { ApplicationOptions, HttpLogRecord, HttpRequest, LauncherSessionSummary, ScopedRecord, ToolProfile } from "../types.d.ts" */
/** @import { ServerResponse } from "node:http" */

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
// Reported by /health; the release package always ships service/package.json.
const appVersion = /** @type {string} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    .version
);

/** @param {ApplicationOptions} options */
export async function createContext(options) {
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
  const sala = await createRoom(dataDirectory, Failure);
  const mundo = createWorld(
    dataDirectory,
    Failure,
    options.mundoPaquete ?? process.env.MUNDO_PAQUETE,
  );
  const lanzador = createLauncherClient(Failure, options.lanzador);
  /** @type {Set<ServerResponse>} */
  const clients = new Set();
  /** @type {import("node:fs").FSWatcher[]} */
  const watchers = [];
  /** @type {NodeJS.Timeout | null | undefined} */
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
  /** @type {import("node:http").Server} */
  let servidorHttp;
  const mcpRemoto = await createRemoteMcp({
    directory: path.join(dataDirectory, "oauth"),
    auth,
    Failure,
    baseUrl: () => {
      const address = /** @type {import("node:net").AddressInfo} */ (
        servidorHttp.address()
      );
      return `http://127.0.0.1:${address.port}/api/v1`;
    },
    now: options.mcpRemoto?.now,
    onChange: change,
  });
  const aprobaciones = await createApprovalQueue(
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
  /**
   * The launcher lists sessions as an array; older fixtures wrap it.
   * @returns {Promise<LauncherSessionSummary[]>}
   */
  const sesionesLanzador = async () => {
    const estado = await lanzador.leer().catch(
      /** @returns {null} */
      () => null,
    );
    if (Array.isArray(estado)) return estado;
    return Array.isArray(estado?.sesiones) ? estado.sesiones : [];
  };
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
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
  /** @param {ToolProfile | null} [parentProfile] */
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
  /**
   * @param {HttpRequest} request
   * @param {string} routeKey
   */
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
    /** @param {...string} required */
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
  /**
   * @param {HttpRequest} request
   * @param {ScopedRecord} record
   */
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
  const bridges = createSessionBridges({ lanzador, userRequests, workOrders });
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
  /** @param {HttpRequest} request */
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
  /** @type {(record: HttpLogRecord) => void} */
  const logger =
    options.logger ||
    (process.env.NODE_ENV === "production"
      ? (record) => console.log(JSON.stringify(record))
      : // Outside production only failures are written, so a 500 is never silent.
        (record) => {
          if (record.event === "http.error")
            console.error(JSON.stringify(record));
        });
  return {
    options,
    appRoot,
    appVersion,
    root,
    dataDirectory,
    history,
    vault,
    finance,
    auth,
    sala,
    mundo,
    lanzador,
    clients,
    watchers,
    change,
    stopLanzadorEvents,
    mcpRemoto,
    aprobaciones,
    workOrders,
    userRequests,
    effects,
    sesionesLanzador,
    runStoreOp,
    resolveServerProfile,
    hasVerifiedBillingGrant,
    assertAgentCapabilityForRoute,
    canAgentAccessScopedRecord,
    bridges,
    shared,
    actorOf,
    logger,
    /** The OAuth metadata needs the listening port, known after createServer. */
    setServer(/** @type {import("node:http").Server} */ server) {
      servidorHttp = server;
    },
    cancelPendingChange() {
      clearTimeout(changeTimer ?? undefined);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof createContext>>} AppContext */
