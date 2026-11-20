import { body, send } from "../io.mjs";
import { ApprovalConflict } from "../../approvals.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const approvalRoutes = (ctx, req) => {
  const { actorOf, aprobaciones: approvals, auth } = ctx;
  const { request, response } = req;
  return {
    "GET /aprobaciones": async () => send(response, 200, approvals.listar()),
    "POST /aprobaciones/decidir": async () => {
      const { id, aprobar: approve, requestId } = await body(request);
      let result;
      try {
        result = await approvals.decidir(id, approve, {
          requestId,
          por: auth.state?.username || actorOf(request),
        });
      } catch (error) {
        if (error instanceof ApprovalConflict)
          throw Object.assign(new Failure(error.message, 409), {
            recibo: error.recibo,
          });
        throw new Failure("Solicitud no pendiente o expirada.", 409);
      }
      return send(response, 200, { ok: true, ...result });
    },
  };
};
