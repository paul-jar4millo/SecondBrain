import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const roomRoutes = (ctx, req) => {
  const { sala } = ctx;
  const { consulta, request, response } = req;
  return {
    "GET /sala": async () => {
      return send(
        response,
        200,
        sala.leer(consulta.get("espacio") ?? undefined),
      );
    },
    "POST /sala/tablero": async () => {
      return send(response, 200, await sala.guardar(await body(request)));
    },
    "POST /sala/encargos": async () => {
      return send(response, 200, await sala.encargar(await body(request)));
    },
    "POST /sala/agentes": async () => {
      // Retired: the room has four fixed agents. The body is still
      // validated so a malformed request keeps answering 400, not 410.
      await body(request);
      return send(response, 201, await sala.crearAgente());
    },
    "POST /sala/agentes/borrar": async () => {
      return send(response, 200, await sala.borrarAgente(await body(request)));
    },
    "GET /sala/imagen": async () => {
      return await sala.imagen(
        new URL(request.url ?? "/", "http://localhost").searchParams.get("id"),
        response,
      );
    },
  };
};
