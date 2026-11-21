import { agentHeaders, body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
import {
  THREAD_ID,
  THREAD_REQUEST_ID,
  toLegacyRequest,
  waitThreadRequest,
} from "./threads.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const requestRoutes = (ctx, req) => {
  const {
    actorOf,
    auth,
    canAgentAccessScopedRecord,
    lanzador,
    runStoreOp,
    userRequests,
  } = ctx;
  const { callerCap, consulta: query, request, response } = req;
  // An agent working in a thread asks through the thread (ADR 0010), so
  // the usuario_* MCP tools keep working unchanged.
  const callerThread =
    typeof callerCap?.sessionId === "string" &&
    THREAD_ID.test(callerCap.sessionId)
      ? callerCap.sessionId
      : null;
  /** @param {unknown} id */
  const threadOf = (id) => {
    if (typeof id !== "string" || !THREAD_REQUEST_ID.test(id)) return null;
    if (!callerThread)
      throw new Failure("Solicitud de thread fuera de tu credencial.", 403);
    return callerThread;
  };
  return {
    "GET /requests": async () => {
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
    "GET /requests/detail": async () => {
      const thread = threadOf(query.get("id"));
      if (thread) {
        const { request: found } = await lanzador.threads.request(
          thread,
          query.get("id"),
        );
        return send(response, 200, { solicitud: toLegacyRequest(found) });
      }
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
    "POST /requests/ask": async () => {
      const data = await body(request);
      if (callerThread) {
        const prompt = String(data.pregunta ?? data.prompt ?? "");
        const options = data.opciones ?? data.options;
        const { request: asked } = await lanzador.threads.ask(callerThread, {
          title: String(
            data.titulo ?? data.title ?? prompt.split("\n")[0] ?? "Pregunta",
          ).slice(0, 300),
          body: prompt,
          ...(options ? { options } : {}),
        });
        return send(response, 200, {
          ok: true,
          solicitud: toLegacyRequest(asked),
        });
      }
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
    "POST /requests/wait": async () => {
      const { id, timeout = 240_000 } = await body(request);
      const thread = threadOf(id);
      if (thread)
        return send(response, 200, {
          ok: true,
          solicitud: toLegacyRequest(
            await waitThreadRequest(lanzador.threads, thread, id, timeout),
          ),
        });
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
    "POST /requests/approval": async () => {
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
    "POST /requests/answer": async () => {
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
    "POST /requests/close-turn": async () => {
      const data = await body(request);
      const result = await runStoreOp(() => userRequests.markTurnClosed(data));
      return send(response, 200, { ok: true, ...result });
    },
    "POST /requests/verify-execution": async () => {
      const data = await body(request);
      const result = await runStoreOp(() =>
        userRequests.verifyApprovalBeforeExecute(data.id, data),
      );
      return send(response, 200, { ok: true, ...result });
    },
    "POST /requests/delivery": async () => {
      const data = await body(request);
      const solicitud = await runStoreOp(() =>
        userRequests.updateDeliveryState(data.id, data),
      );
      return send(response, 200, { ok: true, solicitud });
    },
  };
};
