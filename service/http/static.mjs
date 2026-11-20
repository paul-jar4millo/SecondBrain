// Serves the built dashboard. Unknown paths without an extension fall back to
// index.html so the client router can handle them.
import path from "node:path";
import { readFile, stat, realpath } from "node:fs/promises";
import { Failure } from "../vault.mjs";

/** @import { HttpRequest } from "../types.d.ts" */
/** @import { ServerResponse } from "node:http" */

/**
 * @param {HttpRequest} request
 * @param {ServerResponse} response
 * @param {string} pathname
 * @param {string} staticRoot Absolute path of the built dashboard.
 */
export async function serveStatic(request, response, pathname, staticRoot) {
  if (!["GET", "HEAD"].includes(request.method ?? ""))
    throw new Failure("Método no permitido.", 405);
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
}
