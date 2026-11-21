// What the app needs to start a thread: launcher projects, models, usage and
// the repository linked to each vault project.
import { body, send } from "../io.mjs";
import {
  canonicalWorkspaceUpdate,
  legacyWorkspaces,
} from "../../launcher-wire.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentCatalogRoutes = (ctx, req) => {
  const { lanzador } = ctx;
  const { request, response, legacy } = req;
  return {
    "GET /agents/workspaces": async () => {
      const view = await lanzador.espacios();
      return send(response, 200, legacy ? legacyWorkspaces(view) : view);
    },
    "POST /agents/workspaces": async () => {
      const data = await body(request);
      const view = await lanzador.espacios(
        Object.hasOwn(data, "repositorio")
          ? canonicalWorkspaceUpdate(data)
          : data,
      );
      return send(response, 200, legacy ? legacyWorkspaces(view) : view);
    },
    "GET /agents/projects": async () =>
      send(response, 200, await lanzador.proyectos()),
    "GET /agents/models": async () =>
      send(response, 200, await lanzador.modelos()),
    "GET /agents/usage": async () => send(response, 200, await lanzador.uso()),
  };
};
