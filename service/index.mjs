import { randomUUID } from "node:crypto";
import { routePolicy } from "./routes.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstance } from "./instance.mjs";
import { actorContext, Failure } from "./vault.mjs";
import { createContext } from "./http/context.mjs";
import { prepareResponse, sendError } from "./http/middleware.mjs";
import { serveStatic } from "./http/static.mjs";
import { buildRoutes } from "./http/routes/index.mjs";
import { legacyPaths } from "./http/legacy-paths.mjs";

/** @import { ApplicationOptions, HttpRequest } from "./types.d.ts" */
/** @import { ServerResponse } from "node:http" */

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const apiPrefix = "/api/v1";
/** @param {ApplicationOptions} [options] */
export async function createApplication(options = {}) {
  const context = await createContext(options);
  const legacyHttpRoutes =
    options.legacyHttpRoutes ?? process.env.SB_LEGACY_HTTP_ROUTES !== "off";
  const {
    root,
    dataDirectory,
    history,
    vault,
    finance,
    auth,
    clients,
    watchers,
    stopLanzadorEvents: stopLauncherEvents,
    mcpRemoto: mcpRemote,
    aprobaciones: approvals,
    userRequests,
    effects,
    assertAgentCapabilityForRoute,
    actorOf,
    logger,
  } = context;
  /**
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  const handle = async (request, response) => {
    const requestId = randomUUID(),
      started = performance.now();
    prepareResponse(request, response, requestId, started, logger);
    try {
      // Parsing runs inside the try: an async handler that throws would kill the process.
      let url;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        throw new Failure("Ruta inválida.", 400);
      }
      const successor =
        legacyHttpRoutes && url.pathname.startsWith(apiPrefix + "/")
          ? legacyPaths.get(url.pathname.slice(apiPrefix.length))
          : undefined;
      if (successor) {
        response.setHeader("Deprecation", "@1795132800");
        url.pathname = apiPrefix + successor;
        // Body validation and request logging also use the canonical policy.
        request.url = url.pathname + url.search;
      }
      const { pathname } = url;
      if (
        pathname === "/mcp" ||
        pathname.startsWith("/oauth/") ||
        pathname.startsWith("/.well-known/oauth-")
      ) {
        if (await mcpRemote.manejar(request, response, pathname)) return;
      }
      if (pathname.startsWith("/api/")) {
        response.setHeader("Cache-Control", "no-store");
        const route = pathname.slice(apiPrefix.length),
          method = request.method;
        const policy = routePolicy(method, route);
        if (auth.isRoomAgent(request) && !policy?.room)
          throw new Failure(
            "La credencial de la sala solo permite herramientas de SecondBrain.",
            403,
          );
        if (!["GET", "HEAD"].includes(method ?? "") && !auth.isAgent(request))
          auth.checkCsrf(request);
        if (!policy?.public && !auth.authenticated(request))
          throw new Failure("Inicia sesión para abrir el vault.", 401);
        const callerCap = assertAgentCapabilityForRoute(
          request,
          `${method} ${route}`,
        );
        const consulta = url.searchParams;
        if (
          policy &&
          !policy.query.safeParse(Object.fromEntries(consulta)).success
        )
          throw new Failure("Consulta inválida.");
        /** A query value the route's schema requires, so already validated. */
        const required = (/** @type {string} */ name) =>
          /** @type {string} */ (consulta.get(name));
        /** @type {import("./http/route-types.d.ts").RouteRequest} */
        const req = {
          request,
          response,
          consulta,
          required,
          callerCap,
          legacy: Boolean(successor),
        };
        const routes = buildRoutes(context, req);
        const handler = routes[method + " " + route];
        if (handler) return await handler();
        throw new Failure("Ruta de API no encontrada.", 404);
      }
      if (
        options.serveDashboard === false ||
        process.env.SERVE_DASHBOARD === "off"
      )
        throw new Failure(
          "Interfaz desactivada; el servicio de conocimiento sigue disponible.",
          404,
        );
      await serveStatic(
        request,
        response,
        pathname,
        path.resolve(
          options.staticRoot ||
            process.env.WEB_ROOT ||
            path.join(appRoot, "dashboard", "dist"),
        ),
      );
    } catch (error) {
      sendError(response, error, requestId, logger);
    }
  };
  const server = http.createServer((request, response) =>
    actorContext.run(actorOf(request), () => handle(request, response)),
  );
  // Node's 5-minute default would cut large Maletín uploads on a slow uplink.
  server.requestTimeout = 30 * 60 * 1000;
  context.setServer(server);
  const maintenance = setInterval(() => {
    auth.prune();
    history.prune().catch((error) =>
      logger({
        event: "http.error",
        type: error.name,
        message: error.message,
        stack: error.stack,
      }),
    );
  }, 86400000);
  maintenance.unref();
  const close = async () => {
    clearInterval(maintenance);
    await approvals.cerrar();
    await effects.close();
    await userRequests.cerrar();
    stopLauncherEvents();
    for (const watcher of watchers) watcher.close();
    context.cancelPendingChange();
    for (const client of clients) client.end();
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve(undefined))),
      );
  };
  return {
    server,
    vault,
    finance,
    auth,
    userRequests,
    effects,
    root,
    dataDirectory,
    close,
  };
}
export async function startService() {
  const releaseInstance = await acquireInstance(
    process.env.DATA_DIR || path.join(appRoot, ".data"),
  );
  let app;
  try {
    app = await createApplication();
  } catch (error) {
    await releaseInstance();
    throw error;
  }
  const port = Number(process.env.API_PORT || process.env.PORT || 5080);
  const host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () =>
    console.log(
      `Second Brain · http://${host}:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port} · vault ${app.root}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      await releaseInstance();
      process.exit(0);
    });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await startService();
