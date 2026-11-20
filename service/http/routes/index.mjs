// Every API route handler, grouped by domain. The keys must match the
// policies in service/routes.mjs; route-modules.test.mjs checks both ways.
import { agentCatalogRoutes } from "./agents-catalog.mjs";
import { agentToolRoutes } from "./agents-tools.mjs";
import { approvalRoutes } from "./approvals.mjs";
import { authRoutes } from "./auth.mjs";
import { effectRoutes } from "./effects.mjs";
import { fileRoutes } from "./files.mjs";
import { financeRoutes } from "./finance.mjs";
import { requestRoutes } from "./requests.mjs";
import { roomRoutes } from "./room.mjs";
import { systemRoutes } from "./system.mjs";
import { threadRoutes } from "./threads.mjs";
import { vaultRoutes } from "./vault.mjs";
import { worldRoutes } from "./world.mjs";

/** @import { RouteModule, Routes } from "../route-types.d.ts" */

/** @type {RouteModule[]} */
export const ROUTE_MODULES = [
  systemRoutes,
  authRoutes,
  vaultRoutes,
  financeRoutes,
  fileRoutes,
  roomRoutes,
  worldRoutes,
  agentCatalogRoutes,
  agentToolRoutes,
  requestRoutes,
  effectRoutes,
  approvalRoutes,
  threadRoutes,
];

/** @type {RouteModule} */
export const buildRoutes = (ctx, req) => {
  /** @type {Routes} */
  const routes = {};
  for (const routeModule of ROUTE_MODULES) {
    for (const [key, handler] of Object.entries(routeModule(ctx, req))) {
      if (key in routes) throw new Error(`Ruta duplicada: ${key}`);
      routes[key] = handler;
    }
  }
  return routes;
};
