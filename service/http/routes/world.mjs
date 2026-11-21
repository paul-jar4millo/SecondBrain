import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const worldRoutes = (ctx, req) => {
  const { mundo: world } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /world/overview": async () => {
      return send(response, 200, await world.leer());
    },
    "GET /world/document": async () => {
      return send(response, 200, await world.documento(query.get("path")));
    },
    "GET /world/media": async () => {
      return await world.imagen(query.get("path"), response);
    },
    "POST /world/briefs": async () => {
      return send(response, 201, await world.crearBrief(await body(request)));
    },
    "POST /world/agents": async () => {
      return send(
        response,
        200,
        await world.configurarAgente(await body(request)),
      );
    },
    "POST /world/tasks": async () => {
      return send(response, 201, await world.crearEncargo(await body(request)));
    },
    "POST /world/tasks/status": async () => {
      return send(
        response,
        200,
        await world.cambiarEncargo(await body(request)),
      );
    },
  };
};
