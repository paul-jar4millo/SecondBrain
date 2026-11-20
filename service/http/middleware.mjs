// What every request gets, whatever answers it: security headers, a request
// id, one log line when it finishes and a JSON error when it fails.
import { routePolicy } from "../routes.mjs";
import { send } from "./io.mjs";

/** @import { HttpLogRecord, HttpRequest } from "../types.d.ts" */
/** @import { ServerResponse } from "node:http" */

/**
 * @param {HttpRequest} request
 * @param {ServerResponse} response
 * @param {string} requestId
 * @param {number} started performance.now() when the request arrived.
 * @param {(record: HttpLogRecord) => void} logger
 */
export function prepareResponse(request, response, requestId, started, logger) {
  response.setHeader("X-Request-Id", requestId);
  response.once("finish", () => {
    let route = "unknown";
    try {
      const p = new URL(request.url ?? "/", "http://localhost").pathname.slice(
        "/api/v1".length,
      );
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
}

/**
 * Domain errors carry a status and reach the client; anything else is
 * logged and answered with a generic message.
 * @param {ServerResponse} response
 * @param {any} error
 * @param {string} requestId
 * @param {(record: HttpLogRecord) => void} logger
 */
export function sendError(response, error, requestId, logger) {
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
