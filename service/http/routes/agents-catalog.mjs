// What the app needs to start a thread: launcher projects, models, usage and
// the repository linked to each vault project.
import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentCatalogRoutes = (ctx, req) => {
  const { lanzador } = ctx;
  const { request, response } = req;
  return {
    // The session-era list is gone (ADR 0010); the scene and the old panels
    // read an empty list until they move to the thread projection.
    "GET /agentes/sesiones": async () => send(response, 200, []),
    "GET /agentes/espacios": async () =>
      send(response, 200, await lanzador.espacios()),
    "POST /agentes/espacios": async () =>
      send(response, 200, await lanzador.espacios(await body(request))),
    "GET /agentes/proyectos-lanzador": async () =>
      send(response, 200, await lanzador.proyectos()),
    "GET /agentes/modelos-lanzador": async () =>
      send(response, 200, await lanzador.modelos()),
    "GET /agentes/uso": async () => send(response, 200, await lanzador.uso()),
  };
};
