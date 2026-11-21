import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const roomRoutes = (ctx, req) => {
  const { sala } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /room": async () => {
      return send(response, 200, sala.leer(query.get("espacio") ?? undefined));
    },
    "POST /room/board": async () => {
      return send(response, 200, await sala.guardar(await body(request)));
    },
    "POST /room/work-orders": async () => {
      return send(response, 200, await sala.encargar(await body(request)));
    },
    "POST /room/agents": async () => {
      // Retired: the room has four fixed agents. The body is still
      // validated so a malformed request keeps answering 400, not 410.
      await body(request);
      return send(response, 201, await sala.crearAgente());
    },
    "POST /room/agents/delete": async () => {
      return send(response, 200, await sala.borrarAgente(await body(request)));
    },
    "GET /room/image": async () => {
      return await sala.imagen(
        new URL(request.url ?? "/", "http://localhost").searchParams.get("id"),
        response,
      );
    },
  };
};
