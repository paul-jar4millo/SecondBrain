import { agentHeaders, body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const requestRoutes = (ctx, req) => {
  const {
    actorOf,
    auth,
    canAgentAccessScopedRecord,
    runStoreOp,
    userRequests,
  } = ctx;
  const { callerCap, consulta: query, request, response } = req;
  return {
    "GET /solicitudes": async () => {
      const items = userRequests.list({
        workOrderId: query.get("workOrderId") || undefined,
        kind: query.get("kind") || undefined,
        status: query.get("status") || undefined,
      });
      return send(response, 200, {
        solicitudes: auth.isAgent(request)
          ? items.filter((item) => canAgentAccessScopedRecord(request, item))
          : items,
      });
    },
    "GET /solicitudes/detalle": async () => {
      const solicitud = userRequests.get(query.get("id"));
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
        throw new Failure("Encargo fuera de alcance de tu credencial.", 403);
      }
      const result = await runStoreOp(() =>
        userRequests.createRequest({
          id: data.id,
          createRequestId: data.requestId,
          workOrderId: callerCap?.workOrderId ?? data.workOrderId,
          sessionId: callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
          memberId:
            callerCap?.memberId ?? callerCap?.actor ?? data.memberId ?? agentId,
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
      return send(response, 200, { ok: true, ...result });
    },
    "POST /solicitudes/esperar": async () => {
      const { id, timeout = 240_000 } = await body(request);
      const existing = userRequests.get(id);
      if (
        existing &&
        auth.isAgent(request) &&
        !canAgentAccessScopedRecord(request, existing)
      ) {
        throw new Failure("Solicitud fuera de alcance de tu sesión.", 403);
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
        throw new Failure("Encargo fuera de alcance de tu credencial.", 403);
      }
      const result = await runStoreOp(() =>
        userRequests.createRequest({
          ...data,
          createRequestId: data.requestId,
          workOrderId: callerCap?.workOrderId ?? data.workOrderId,
          sessionId: callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
          memberId:
            callerCap?.memberId ?? callerCap?.actor ?? data.memberId ?? agentId,
          kind: "approval",
        }),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /solicitudes/responder": async () => {
      const data = await body(request);
      const result = await runStoreOp(() =>
        userRequests.respond(data.id, {
          ...data,
          by: auth.state?.username || actorOf(request),
          origin: data.origin || "app",
        }),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /solicitudes/cerrar-turno": async () => {
      const data = await body(request);
      const result = await runStoreOp(() => userRequests.markTurnClosed(data));
      return send(response, 200, { ok: true, ...result });
    },
    "POST /solicitudes/verificar-ejecucion": async () => {
      const data = await body(request);
      const result = await runStoreOp(() =>
        userRequests.verifyApprovalBeforeExecute(data.id, data),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /solicitudes/entrega": async () => {
      const data = await body(request);
      const solicitud = await runStoreOp(() =>
        userRequests.updateDeliveryState(data.id, data),
      );
      return send(response, 200, { ok: true, solicitud });
    },
  };
};
