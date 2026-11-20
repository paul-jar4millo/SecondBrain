import { randomUUID } from "node:crypto";
import { routePolicy } from "./routes.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat, realpath } from "node:fs/promises";

import { acquireInstance } from "./instance.mjs";
import { actorContext, Failure } from "./vault.mjs";

import { send } from "./http/io.mjs";
import { createContext } from "./http/context.mjs";
import { TEAM_ACTION, handleTeamAction } from "./http/team-actions.mjs";
import { buildRoutes } from "./http/routes/index.mjs";

/** @import { ApplicationOptions, HttpRequest } from "./types.d.ts" */

/** @import { ServerResponse } from "node:http" */

const appRoot = fileURLToPath(new URL("..", import.meta.url));
/** @param {ApplicationOptions} [options] */
export async function createApplication(options = {}) {
  const context = await createContext(options);
  const {
    root,
    dataDirectory,
    history,
    vault,
    finance,
    auth,
    clients,
    watchers,
    stopLanzadorEvents,
    mcpRemoto,
    aprobaciones,
    workOrders,
    userRequests,
    effects,
    assertAgentCapabilityForRoute,
    bridges,
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
    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      let route = "unknown";
      try {
        const p = new URL(
          request.url ?? "/",
          "http://localhost",
        ).pathname.slice("/api/v1".length);
        if (routePolicy(request.method, p)) route = p;
      } catch {}
      logger({
        event: "http",
        requestId,
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
    try {
      // Parsing runs inside the try: an async handler that throws would kill the process.
      let pathname;
      try {
        pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      } catch {
        throw new Failure("Ruta inválida.", 400);
      }
      if (
        pathname === "/mcp" ||
        pathname.startsWith("/oauth/") ||
        pathname.startsWith("/.well-known/oauth-")
      ) {
        if (await mcpRemoto.manejar(request, response, pathname)) return;
      }
      if (pathname.startsWith("/api/")) {
        response.setHeader("Cache-Control", "no-store");
        const route = pathname.slice("/api/v1".length),
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
        const consulta = new URL(request.url ?? "/", "http://localhost")
          .searchParams;
        const accionEquipo = method === "POST" && TEAM_ACTION.exec(route);
        if (accionEquipo)
          return await handleTeamAction(
            context,
            { request, response, callerCap },
            accionEquipo[1],
          );
        if (
          policy &&
          !policy.query.safeParse(Object.fromEntries(consulta)).success
        )
          throw new Failure("Consulta inválida.");
        /** A query value the route's schema requires, so already validated. */
        const required = (/** @type {string} */ name) =>
          /** @type {string} */ (consulta.get(name));
        /** @type {import("./http/route-types.d.ts").RouteRequest} */
        const req = { request, response, consulta, required, callerCap };
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
      if (!["GET", "HEAD"].includes(request.method ?? ""))
        throw new Failure("Método no permitido.", 405);
      const staticRoot = path.resolve(
        options.staticRoot ||
          process.env.WEB_ROOT ||
          path.join(appRoot, "dashboard", "dist"),
      );
      let relative;
      try {
        relative = decodeURIComponent(pathname);
      } catch {
        throw new Failure("Ruta inválida.");
      }
      if (
        relative.includes("\\") ||
        relative.split("/").some((p) => p === ".." || p.startsWith("."))
      )
        throw new Failure("Ruta inválida.", 403);
      let target = path.join(
        staticRoot,
        relative === "/" ? "index.html" : relative,
      );
      try {
        const real = await realpath(target);
        if (!real.startsWith(staticRoot + path.sep))
          throw new Failure("Ruta inválida.", 403);
        if (!(await stat(target)).isFile())
          throw Object.assign(new Error(), { code: "ENOENT" });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        if (path.extname(relative))
          throw new Failure("Archivo no disponible.", 404);
        target = path.join(staticRoot, "index.html");
      }
      const data = await readFile(target);
      /** @type {Partial<Record<string, string>>} */
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
      };
      response.writeHead(200, {
        "Content-Type":
          (types[path.extname(target)] || "application/octet-stream") +
          "; charset=utf-8",
        "Cache-Control":
          path.basename(target) === "index.html" ||
          path.basename(target) === "sw.js"
            ? "no-cache"
            : "public, max-age=3600",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!error.status)
        logger({
          event: "http.error",
          requestId,
          type: error.name || "Error",
          message: String(error.message ?? error),
          stack: error.stack,
        });
      if (!response.headersSent)
        send(response, error.status || 500, {
          error: error.status
            ? error.message
            : "No se pudo completar la operación. El archivo original se conserva.",
          code: error.code,
          server: error.server,
          ...(error.recibo ? { recibo: error.recibo } : {}),
          ...(error.solicitud ? { solicitud: error.solicitud } : {}),
          ...(error.snapshot ? { snapshot: error.snapshot } : {}),
          ...(error.operacion ? { operacion: error.operacion } : {}),
        });
      else response.end();
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
    bridges.close();
    clearInterval(maintenance);
    await aprobaciones.cerrar();
    await effects.close();
    await userRequests.cerrar();
    await workOrders.close();
    stopLanzadorEvents();
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
    workOrders,
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
