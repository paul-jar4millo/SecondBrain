import { agentHeaders, body, relayArtifactDownload, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
import { ENGINE_ACTOR } from "../../agent-profiles.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const workOrderRoutes = (ctx, req) => {
  const {
    actorOf,
    auth,
    lanzador: launcher,
    runStoreOp,
    sesionesLanzador: launcherSessions,
    workOrders,
  } = ctx;
  const { callerCap, consulta: query, request, required, response } = req;
  return {
    "GET /encargos": async () =>
      send(response, 200, { encargos: workOrders.list() }),
    "GET /encargos/detalle": async () => {
      const id = required("id");
      const rawCursor = query.get("cursor");
      const cursor = rawCursor !== null ? Number(rawCursor) : 0;
      const recipientScope = query.get("recipientScope") || undefined;
      const requestedMemberId = query.get("memberId") || undefined;
      const wo = workOrders.get(id);
      if (!wo) throw new Failure("Encargo no encontrado.", 404);
      if (callerCap?.workOrderId && callerCap.workOrderId !== id) {
        throw new Failure("Encargo fuera de alcance de tu credencial.", 403);
      }
      /** @type {{ cursor: number, recipientScope?: string, memberId?: string }} */
      let feedArgs = {
        cursor,
        recipientScope,
        memberId: requestedMemberId,
      };
      if (auth.isRoomAgent(request)) {
        const { agentId } = agentHeaders(request);
        const authIdentity = callerCap?.memberId || callerCap?.actor || agentId;
        const matched = authIdentity
          ? wo.team.find((m) =>
              requestedMemberId
                ? m.id === requestedMemberId &&
                  (m.characterId === authIdentity ||
                    m.id === authIdentity ||
                    (callerCap?.actor && m.characterId === callerCap.actor))
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
      const detail = await runStoreOp(() =>
        workOrders.getSnapshotAndFeed(id, feedArgs),
      );
      if (!detail) throw new Failure("Encargo no encontrado.", 404);
      return send(response, 200, detail);
    },
    "GET /encargos/artefactos/descargar": async () => {
      const workOrderId = required("workOrderId");
      const artifactId = query.get("artifactId");
      const wo = workOrders.get(workOrderId);
      if (!wo) throw new Failure("Encargo no encontrado.", 404);
      if (callerCap?.workOrderId && callerCap.workOrderId !== workOrderId) {
        throw new Failure("Acceso de encargo no autorizado.", 403);
      }
      if (auth.isRoomAgent(request)) {
        const { agentId } = agentHeaders(request);
        const authIdentity = callerCap?.memberId || callerCap?.actor || agentId;
        const member = authIdentity
          ? wo.team.find(
              (m) =>
                m.characterId === authIdentity ||
                m.id === authIdentity ||
                (callerCap?.actor && m.characterId === callerCap.actor),
            )
          : null;
        if (!member) throw new Failure("Acceso de encargo no autorizado.", 403);
      }
      const art = (wo.artifacts || []).find((a) => a.id === artifactId);
      if (!art || !art.sessionId) {
        throw new Failure("Artefacto no encontrado.", 404);
      }
      const upstream = await launcher.descargarArtefacto(
        art.sessionId,
        artifactId,
      );
      await relayArtifactDownload(response, upstream, art);
      return;
    },
    "POST /encargos": async () => {
      const data = await body(request);
      const task = await runStoreOp(() => workOrders.createWorkOrder(data));
      return send(response, 201, { ok: true, encargo: task });
    },
    "POST /encargos/equipo": async () => {
      const data = await body(request);
      const task = await runStoreOp(() =>
        workOrders.updateTeam(data.workOrderId, data),
      );
      return send(response, 200, { ok: true, encargo: task });
    },
    "POST /encargos/iniciar": async () => {
      const { workOrderId, expectedRevision } = await body(request);
      const task = await runStoreOp(() =>
        workOrders.startWorkOrder(workOrderId, { expectedRevision }),
      );
      return send(response, 200, { ok: true, encargo: task });
    },
    "POST /encargos/mensajes": async () => {
      const data = await body(request);
      const result = await runStoreOp(() =>
        workOrders.enqueueMessage(data.workOrderId, data),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /encargos/eventos": async () => {
      const data = await body(request);
      const { agentId, sessionUuid } = agentHeaders(request);
      const result = await runStoreOp(() =>
        workOrders.appendEvent(data.workOrderId, {
          ...data,
          sourceId:
            data.sourceId ||
            (auth.isRoomAgent(request) && agentId ? agentId : actorOf(request)),
          sessionId: data.sessionId ?? sessionUuid,
        }),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /encargos/handoffs": async () => {
      const data = await body(request);
      const result = await runStoreOp(() =>
        workOrders.createHandoff(data.workOrderId, data),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /encargos/verificar": async () => {
      const data = await body(request);
      const task = await runStoreOp(() =>
        workOrders.verifyWorkOrder(data.workOrderId, {
          ...data,
          actor: auth.state?.username || actorOf(request),
        }),
      );
      return send(response, 200, { ok: true, encargo: task });
    },
    "POST /encargos/integrar": async () => {
      const data = await body(request);
      const sessionObj = (await launcherSessions()).find(
        (s) => s.id === data.sesion,
      );
      if (!sessionObj) throw new Failure("Sesión no activa.", 403);
      const actor = ENGINE_ACTOR[sessionObj.motor];
      const result = await launcher.equipo("integrar", data.sesion, actor, {
        entregableIds: data.entregableIds,
        resoluciones: data.resoluciones,
        targetDir: data.targetDir,
      });
      const targetWo = data.workOrderId || sessionObj.workOrderId;
      if (targetWo && workOrders.get(targetWo)) {
        await runStoreOp(() =>
          workOrders.appendEvent(targetWo, {
            sourceId: actorOf(request),
            sessionId: data.sesion,
            idempotencyKey: result.integracion?.id
              ? `wo-integ:${result.integracion.id}`
              : undefined,
            type: "member.status",
            provenance: "observed",
            payload: {
              reason:
                result.estado === "conflicto"
                  ? "integration_conflict"
                  : "integration_completed",
              estado: result.estado,
              conflictos: result.conflictos || [],
              // Local paths stay in the lanzador; events carry hashes.
              integrados: (result.integrados || []).map(
                /** @param {Record<string, unknown>} entry */
                ({ destino: _target, ...item }) => item,
              ),
            },
          }),
        ).catch(() => {});
      }
      return send(response, 200, result);
    },
  };
};
