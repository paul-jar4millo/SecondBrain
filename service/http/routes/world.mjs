import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const worldRoutes = (ctx, req) => {
  const { mundo: world } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /mundo/overview": async () => {
      return send(response, 200, await world.leer());
    },
    "GET /mundo/document": async () => {
      return send(response, 200, await world.documento(query.get("path")));
    },
    "GET /mundo/media": async () => {
      return await world.imagen(query.get("path"), response);
    },
    "POST /mundo/briefs": async () => {
      return send(response, 201, await world.crearBrief(await body(request)));
    },
    "POST /mundo/agents": async () => {
      return send(
        response,
        200,
        await world.configurarAgente(await body(request)),
      );
    },
    "POST /mundo/tasks": async () => {
      return send(response, 201, await world.crearEncargo(await body(request)));
    },
    "POST /mundo/tasks/status": async () => {
      return send(
        response,
        200,
        await world.cambiarEncargo(await body(request)),
      );
    },
  };
};
