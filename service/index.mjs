import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { routePolicy } from "./routes.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { zip, strToU8 } from "fflate";
import { acquireInstance } from "./instance.mjs";
import { hash } from "./vault.mjs";
import { actorContext, Failure, stableId } from "./vault.mjs";

import {
  MOTOR_ACTOR,
  intersectList,
  intersectProfileBounds,
} from "./agent-profiles.mjs";

import { sendItems } from "./http-items.mjs";

import { operationalStatus } from "./operational-status.mjs";

import { body, send, validateNotePath } from "./http/io.mjs";
import { createContext } from "./http/context.mjs";
import { agentConversationRoutes } from "./http/routes/agents-conversation.mjs";
import { workOrderRoutes } from "./http/routes/work-orders.mjs";
import { requestRoutes } from "./http/routes/requests.mjs";
import { effectRoutes } from "./http/routes/effects.mjs";
import { approvalRoutes } from "./http/routes/approvals.mjs";
import { fileRoutes } from "./http/routes/files.mjs";
import { financeRoutes } from "./http/routes/finance.mjs";
import { authRoutes } from "./http/routes/auth.mjs";
import { roomRoutes } from "./http/routes/room.mjs";
import { worldRoutes } from "./http/routes/world.mjs";

/** @import { ApplicationOptions, HttpRequest, ToolProfile } from "./types.d.ts" */
/** @import { WorkOrderManifest } from "./work-order-types.d.ts" */
/** @import { ServerResponse } from "node:http" */

const appRoot = fileURLToPath(new URL("..", import.meta.url));
// Reported by /health; the release package always ships service/package.json.
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
/** @param {ApplicationOptions} [options] */
export async function createApplication(options = {}) {
  const context = await createContext(options);
  const {
    root,
    dataDirectory,
    history,
    vault,
    finance,
    auth,
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
    bridges,
    actorOf,
    logger,
  } = context;
  /**
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  const handle = async (request, response) => {
    const requestId = randomUUID(),
      started = performance.now();
    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      let route = "unknown";
      try {
        const p = new URL(
          request.url ?? "/",
          "http://localhost",
        ).pathname.slice("/api/v1".length);
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
        pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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
        if (!["GET", "HEAD"].includes(method ?? "") && !auth.isAgent(request))
          auth.checkCsrf(request);
        if (!policy?.public && !auth.authenticated(request))
          throw new Failure("Inicia sesión para abrir el vault.", 401);
        const callerCap = assertAgentCapabilityForRoute(
          request,
          `${method} ${route}`,
        );
        const consulta = new URL(request.url ?? "/", "http://localhost")
          .searchParams;
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
            /** @type {ToolProfile} */
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
            /** @type {WorkOrderManifest | undefined} */
            const manifest = forwarded.manifest;
            const manifestCard =
              datos.memberId && manifest?.team
                ? manifest.team.find((c) => c.id === datos.memberId)
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
            // Both headers were validated against their patterns above.
            resultado = await lanzador.equipo(
              accion,
              /** @type {string} */ (sesion),
              /** @type {string} */ (actor),
              forwarded,
            );
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
              bridges.bridge(
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
                    /** @param {Record<string, unknown>} entry */
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
        /** A query value the route's schema requires, so already validated. */
        const required = (/** @type {string} */ name) =>
          /** @type {string} */ (consulta.get(name));
        /** @type {import("./http/route-types.d.ts").RouteRequest} */
        const req = { request, response, consulta, required, callerCap };
        /** @type {Partial<Record<string, () => Promise<unknown>>>} */
        const routes = {
          ...agentConversationRoutes(context, req),
          ...workOrderRoutes(context, req),
          ...requestRoutes(context, req),
          ...effectRoutes(context, req),
          ...approvalRoutes(context, req),
          ...fileRoutes(context, req),
          ...financeRoutes(context, req),
          ...authRoutes(context, req),
          ...roomRoutes(context, req),
          ...worldRoutes(context, req),
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
            routes["GET /agentes/terminal/stream"]?.(),
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
              for await (const chunk of upstream.body ?? []) {
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
          "GET /agentes/sesiones/diff": async () =>
            send(
              response,
              200,
              await lanzador.diff({
                id: required("id"),
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
              bridges.bridge(
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
      if (!["GET", "HEAD"].includes(request.method ?? ""))
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
      /** @type {Partial<Record<string, string>>} */
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
  context.setServer(server);
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
    bridges.close();
    clearInterval(maintenance);
    await aprobaciones.cerrar();
    await effects.close();
    await userRequests.cerrar();
    await workOrders.close();
    stopLanzadorEvents();
    for (const watcher of watchers) watcher.close();
    context.cancelPendingChange();
    for (const client of clients) client.end();
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve(undefined))),
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
/**
 * @param {import("./vault-types.d.ts").VaultItem[]} items
 */
function reminders(items) {
  const now = Date.now();
  return items
    .filter(
      (i) =>
        !i.deleted &&
        !["done", "cancelled"].includes(i.status ?? "") &&
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
