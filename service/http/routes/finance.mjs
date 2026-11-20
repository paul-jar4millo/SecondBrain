import { body, send } from "../io.mjs";
import { mexicoDay } from "../../finance.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const financeRoutes = (ctx, req) => {
  const {
    actorOf,
    aprobaciones: approvals,
    auth,
    change,
    finance,
    vault,
  } = ctx;
  const { request, response } = req;
  return {
    "GET /finance/overview": async () => {
      return send(response, 200, await finance.overview(mexicoDay()));
    },
    "POST /finance/ops": async () => {
      const operation = await body(request);
      const previous = await finance.previous(operation);
      if (previous) return send(response, 200, previous);
      await finance.validate(operation, mexicoDay());
      let approvalId;
      if (auth.isRoomAgent(request)) {
        const solicitud = await approvals.solicitar({
          actor: actorOf(request),
          operacion: operation,
        });
        approvalId = solicitud.id;
        if ((await solicitud.esperar) !== "aprobada")
          throw new Failure("La operación no fue aprobada.", 403);
      }
      let result;
      try {
        result = await finance.run(operation, mexicoDay());
      } catch (error) {
        if (approvalId)
          await approvals.finalizar(
            approvalId,
            "No aplicada: la operación no se pudo guardar.",
          );
        throw error;
      }
      if (approvalId)
        await approvals.finalizar(
          approvalId,
          "Aplicada: la operación se guardó.",
        );
      change();
      return send(response, 200, result);
    },
    "GET /finance/ledger": async () => {
      return send(response, 200, await vault.ledger());
    },
  };
};
