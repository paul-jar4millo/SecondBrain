import { agentHeaders, body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const effectRoutes = (ctx, req) => {
  const {
    actorOf,
    auth,
    canAgentAccessScopedRecord,
    effects,
    runStoreOp,
    workOrders,
  } = ctx;
  const { callerCap, consulta, request, required, response } = req;
  return {
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
      const operacion = effects.get(required("id"), {
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
        throw new Failure("Encargo fuera de alcance de tu credencial.", 403);
      }
      const resolvedMemberId =
        callerCap?.memberId ?? callerCap?.actor ?? data.memberId ?? agentId;
      const resolvedWorkOrderId = callerCap?.workOrderId ?? data.workOrderId;
      let resolvedProfile = callerCap?.profileId ?? data.toolProfileId;
      let allowedCategoriesOverride = callerCap
        ? callerCap.allowedEffectCategories
        : undefined;
      if (!callerCap && resolvedWorkOrderId && auth.isRoomAgent(request)) {
        const wo = workOrders.get(resolvedWorkOrderId);
        const member = wo?.team?.find(
          (m) =>
            m.id === resolvedMemberId || (agentId && m.characterId === agentId),
        );
        if (member?.toolProfileId) {
          resolvedProfile = member.toolProfileId;
        }
      }
      const { billingAuthorized: _ignoredClientBilling, ...safeData } = data;
      const resultado = await runStoreOp(() =>
        effects.prepareEffect({
          ...safeData,
          fromAgent: isAgentCall,
          workOrderId: resolvedWorkOrderId,
          memberId: resolvedMemberId,
          sessionId: callerCap?.sessionId ?? data.sessionId ?? sessionUuid,
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
  };
};
