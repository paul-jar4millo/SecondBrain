// What the app needs to start a thread: launcher projects, models, usage and
// the repository linked to each vault project.
import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentCatalogRoutes = (ctx, req) => {
  const { lanzador } = ctx;
  const { request, response } = req;
  return {
    "GET /agents/workspaces": async () => {
      return send(response, 200, await lanzador.espacios());
    },
    "POST /agents/workspaces": async () => {
      return send(response, 200, await lanzador.espacios(await body(request)));
    },
    "GET /agents/projects": async () =>
      send(response, 200, await lanzador.proyectos()),
    "GET /agents/models": async () =>
      send(response, 200, await lanzador.modelos()),
    "GET /agents/usage": async () => send(response, 200, await lanzador.uso()),
  };
};
