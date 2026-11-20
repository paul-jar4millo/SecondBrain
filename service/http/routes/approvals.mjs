import { body, send } from "../io.mjs";
import { ConflictoAprobacion } from "../../aprobaciones.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const approvalRoutes = (ctx, req) => {
  const { actorOf, aprobaciones, auth } = ctx;
  const { request, response } = req;
  return {
    "GET /aprobaciones": async () => send(response, 200, aprobaciones.listar()),
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
  };
};
