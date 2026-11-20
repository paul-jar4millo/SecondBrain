import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const worldRoutes = (ctx, req) => {
  const { mundo } = ctx;
  const { consulta, request, response } = req;
  return {
    "GET /mundo/overview": async () => {
      return send(response, 200, await mundo.leer());
    },
    "GET /mundo/document": async () => {
      return send(response, 200, await mundo.documento(consulta.get("path")));
    },
    "GET /mundo/media": async () => {
      return await mundo.imagen(consulta.get("path"), response);
    },
    "POST /mundo/briefs": async () => {
      return send(response, 201, await mundo.crearBrief(await body(request)));
    },
    "POST /mundo/agents": async () => {
      return send(
        response,
        200,
        await mundo.configurarAgente(await body(request)),
      );
    },
    "POST /mundo/tasks": async () => {
      return send(response, 201, await mundo.crearEncargo(await body(request)));
    },
    "POST /mundo/tasks/status": async () => {
      return send(
        response,
        200,
        await mundo.cambiarEncargo(await body(request)),
      );
    },
  };
};
