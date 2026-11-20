import { body, send } from "../io.mjs";
import { once } from "node:events";
import { Failure } from "../../vault.mjs";
import { ENGINE_ACTOR, intersectList } from "../../agent-profiles.mjs";
import { randomUUID } from "node:crypto";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentSessionRoutes = (ctx, req) => {
  const {
    actorOf,
    auth,
    bridges,
    hasVerifiedBillingGrant,
    lanzador,
    options,
    resolveServerProfile,
    runStoreOp,
    workOrders,
  } = ctx;
  const { consulta: query, request, required, response } = req;
  /**
   * Relays the launcher stream of a session, as its terminal or as its conversation.
   * @param {boolean} conversation
   */
  const streamSession = async (conversation) => {
    // The launcher's SSE goes through untouched: no buffering, and
    // either side closing ends the other. The browser retries.
    const origin = new AbortController();
    const cut = () => origin.abort();
    response.on("close", cut);
    const upstream = await lanzador.flujo(
      query.get("id"),
      origin.signal,
      conversation,
    );
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    // A session that ends (logout, expiry) must not keep a stream open.
    const watch = setInterval(() => {
      if (!auth.authenticated(request)) origin.abort();
    }, 20000);
    watch.unref();
    try {
      for await (const chunk of upstream.body ?? []) {
        if (response.destroyed) break;
        if (!response.write(chunk)) await once(response, "drain");
      }
    } catch {
      /* either side closed */
    } finally {
      clearInterval(watch);
      response.off("close", cut);
      origin.abort();
      response.end();
    }
  };
  return {
    "GET /agentes/sesiones": async () => {
      const sessions = await lanzador.leer();
      // Long transcripts are only read when a conversation is open; the
      // scene and the lists ask for this light version every few seconds.
      return send(
        response,
        200,
        query.has("resumen") && Array.isArray(sessions)
          ? sessions.map(({ mensajes: _m, resultado: _r, ...s }) => s)
          : sessions,
      );
    },
    "GET /agentes/espacios": async () =>
      send(response, 200, await lanzador.espacios()),
    "POST /agentes/espacios": async () =>
      send(response, 200, await lanzador.espacios(await body(request))),
    "GET /agentes/conversacion/stream": () => streamSession(true),
    "GET /agentes/terminal/stream": () => streamSession(false),
    "POST /agentes/terminal/entrada": async () =>
      send(response, 200, await lanzador.entrada(await body(request))),
    "GET /agentes/sesiones/diff": async () =>
      send(
        response,
        200,
        await lanzador.diff({
          id: required("id"),
          desde: query.get("desde") ?? undefined,
          hasta: query.get("hasta") ?? undefined,
        }),
      ),
    "GET /agentes/sesiones/pr/propuesta": async () =>
      send(response, 200, await lanzador.propuestaPr(query.get("id"))),
    "POST /agentes/sesiones/revertir": async () =>
      send(response, 200, await lanzador.revertir(await body(request))),
    "POST /agentes/sesiones/pr": async () =>
      send(response, 200, await lanzador.pr(await body(request))),
    "POST /agentes/sesiones/pr/redactar": async () =>
      send(response, 200, await lanzador.redactarPr((await body(request)).id)),
    "GET /agentes/proyectos-lanzador": async () => {
      return send(response, 200, await lanzador.proyectos());
    },
    "GET /agentes/modelos-lanzador": async () => {
      return send(response, 200, await lanzador.modelos());
    },
    "GET /agentes/uso": async () => send(response, 200, await lanzador.uso()),
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
                    await resolveServerProfile(targetMember.toolProfileId),
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
      const sessionActor = ENGINE_ACTOR[payload.motor] || null;
      const minted = await auth.issueCapability({
        sessionId: preassignedSessionId,
        workOrderId: payload.workOrderId ?? null,
        memberId: payload.memberId || sessionActor || preassignedSessionId,
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
        const { billingAuthorized: _ignoredBilling, ...restPayload } = payload;
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
            sourceId: session.memberId || payload.memberId || actorOf(request),
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
  };
};
