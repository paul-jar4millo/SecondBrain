import { agentHeaders, body, relayArtifactDownload, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
import { MOTOR_ACTOR } from "../../agent-profiles.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const workOrderRoutes = (ctx, req) => {
  const { actorOf, auth, lanzador, runStoreOp, sesionesLanzador, workOrders } =
    ctx;
  const { callerCap, consulta, request, required, response } = req;
  return {
    "GET /encargos": async () =>
      send(response, 200, { encargos: workOrders.list() }),
    "GET /encargos/detalle": async () => {
      const id = required("id");
      const rawCursor = consulta.get("cursor");
      const cursor = rawCursor !== null ? Number(rawCursor) : 0;
      const recipientScope = consulta.get("recipientScope") || undefined;
      const requestedMemberId = consulta.get("memberId") || undefined;
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
      const detalle = await runStoreOp(() =>
        workOrders.getSnapshotAndFeed(id, feedArgs),
      );
      if (!detalle) throw new Failure("Encargo no encontrado.", 404);
      return send(response, 200, detalle);
    },
    "GET /encargos/artefactos/descargar": async () => {
      const workOrderId = required("workOrderId");
      const artifactId = consulta.get("artifactId");
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
      const upstream = await lanzador.descargarArtefacto(
        art.sessionId,
        artifactId,
      );
      await relayArtifactDownload(response, upstream, art);
      return;
    },
    "POST /encargos": async () => {
      const data = await body(request);
      const encargo = await runStoreOp(() => workOrders.createWorkOrder(data));
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
            (auth.isRoomAgent(request) && agentId ? agentId : actorOf(request)),
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
      const actor = MOTOR_ACTOR[sesionObj.motor];
      const resultado = await lanzador.equipo("integrar", data.sesion, actor, {
        entregableIds: data.entregableIds,
        resoluciones: data.resoluciones,
        targetDir: data.targetDir,
      });
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
                /** @param {Record<string, unknown>} entry */
                ({ destino: _destino, ...item }) => item,
              ),
            },
          }),
        ).catch(() => {});
      }
      return send(response, 200, resultado);
    },
  };
};
