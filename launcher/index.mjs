// The launcher (ADR 0003, 0010): runs agent threads for the service on
// loopback. Besides the thread API it answers the catalogs the app needs:
// projects, models, usage, workspace links and the tool catalog.
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstance } from "../contracts/src/node/instance.mjs";
import { createModelCatalog } from "./models.mjs";
import { openWorkspaces } from "./workspaces.mjs";
import { createUsage } from "./usage.mjs";
import { createGit } from "./git.mjs";
import { LauncherError } from "./errors.mjs";
import { redactDiagnostic } from "./diagnostics.mjs";
import { CAPABILITIES, REQUIREMENTS } from "./engines.mjs";
import { readLimits } from "./limits.mjs";
import { createToolCatalogStore } from "./tool-catalog.mjs";
import { openThreads } from "./threads/runtime.mjs";

/** @import { LauncherRequestBody, LauncherServerOptions } from "./launcher-server-types.d.ts" */

const MAX_BODY = 512_000;

export async function arrancar(env = process.env) {
  const limits = readLimits(env);
  /** An absolute path the launcher cannot start without. */
  const requiredPath = (/** @type {string} */ name) => {
    const value = env[name];
    if (!value || !path.isAbsolute(value))
      throw new Error(`Falta configuración: ${name}`);
    return value;
  };
  const dataDir = requiredPath("SB_LAUNCHER_DATA_DIR");
  const controlHashFile = requiredPath("SB_CONTROL_HASH_FILE");
  const projectsFile = requiredPath("SB_PROJECTS_FILE");
  const port = Number(env.SB_LAUNCHER_PORT ?? 8092);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Puerto inválido");
  const projects = JSON.parse(await readFile(projectsFile, "utf8"));
  if (!projects || Array.isArray(projects) || typeof projects !== "object")
    throw new Error("Proyectos inválidos");
  for (const [nombre, directorio] of Object.entries(projects)) {
    if (
      !/^[a-z0-9_-]+$/i.test(nombre) ||
      typeof directorio !== "string" ||
      !path.isAbsolute(directorio)
    )
      throw new Error("Proyecto inválido");
    projects[nombre] = await realpath(directorio);
    if (!(await stat(projects[nombre])).isDirectory())
      throw new Error("Proyecto no es directorio");
  }
  const controlHash = (await readFile(controlHashFile, "utf8")).trim();
  const release = await acquireInstance(dataDir);
  try {
    const spaces = await openWorkspaces({
      archivo: path.join(dataDir, "espacios.json"),
      proyectos: projects,
      workspaces: path.join(dataDir, "workspaces"),
    });
    const gitExecutor = createGit({ env });
    const toolCatalog = await createToolCatalogStore({ dataDir, env });
    const threads = openThreads({
      env,
      dataDir,
      projects,
      git: gitExecutor.git,
      gh: gitExecutor.gh,
      maxActive: limits.maxActivos,
      toolCatalog,
    });
    const server = createLauncherServer({
      toolCatalog,
      catalogo: createModelCatalog({ env }),
      uso: createUsage({ env }),
      proyectos: projects,
      espacios: spaces,
      controlHash,
      threads,
    });
    server.once("close", () => {
      void threads
        .close()
        .catch(() => {})
        .finally(() => release().catch(() => {}));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(undefined));
    });
    return server;
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * @param {unknown} header
 * @param {string} hash
 */
function authorized(header, hash) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const expected = Buffer.from(hash, "hex");
  const received = createHash("sha256").update(header.slice(7)).digest();
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** @param {LauncherServerOptions} options */
export function createLauncherServer({
  toolCatalog = null,
  catalogo: catalog = createModelCatalog({ env: {}, agy: async () => "" }),
  uso: usage = async () => ({}),
  proyectos: projects = {},
  espacios: spaces,
  controlHash,
  threads = null,
  registrar: register = (line) => console.error(line),
}) {
  if (!/^[a-f0-9]{64}$/i.test(controlHash))
    throw new Error("Credencial de control inválida");
  /** @type {Awaited<ReturnType<typeof createToolCatalogStore>> | null} */
  let fallbackToolCatalog = null;
  const getToolCatalog = async () =>
    toolCatalog ||
    (fallbackToolCatalog ??= await createToolCatalogStore({ env: {} }));

  return http.createServer(async (req, res) => {
    /** @type {LauncherRequestBody | undefined} */
    let datos;
    /**
     * @param {number} status
     * @param {unknown} [data]
     */
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    try {
      if (!authorized(req.headers.authorization, controlHash))
        return send(401, { error: "No autorizado." });
      const ruta = new URL(req.url ?? "/", "http://127.0.0.1");
      if (threads && (await threads.http.handle(req, res, ruta))) return;
      const route = `${req.method} ${ruta.pathname}`;
      switch (route) {
        case "GET /status":
          return send(200, { ok: true });
        case "GET /capabilities":
          return send(200, { motores: CAPABILITIES, requisitos: REQUIREMENTS });
        case "GET /projects":
          return send(200, Object.keys(projects));
        case "GET /models":
          return send(200, await catalog.modelos());
        case "GET /usage":
          return send(200, await usage());
        case "GET /workspaces":
          if (spaces) {
            return send(200, spaces.read());
          }
          break;
        case "GET /tools/catalog": {
          const cat = await getToolCatalog();
          if (ruta.searchParams.get("probe") === "true")
            await cat.runHealthChecks({ optIn: true, probeTimeoutMs: 1500 });
          return send(
            200,
            cat.evaluateCatalog({
              motor: ruta.searchParams.get("motor") || "codex",
              profileId: ruta.searchParams.get("profileId") || "ejecucion",
              parentProfileId: ruta.searchParams.get("parentProfileId") || null,
              memberId: ruta.searchParams.get("memberId") || null,
              sessionId: ruta.searchParams.get("sessionId") || null,
            }),
          );
        }
      }
      if (
        req.method !== "POST" ||
        !["/workspaces", "/tools/profiles", "/tools/skills/resolve"].includes(
          ruta.pathname,
        )
      )
        return send(404, { error: "Ruta no encontrada." });
      // Chunks stay as bytes until the end: a multi-byte character split
      // between two chunks must not be decoded (and broken) separately.
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        const buffer = Buffer.from(part);
        bytes += buffer.length;
        if (bytes > MAX_BODY)
          return send(413, { error: "Petición demasiado grande." });
        parts.push(buffer);
      }
      try {
        datos = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        return send(400, { error: "JSON inválido." });
      }
      if (!datos || typeof datos !== "object" || Array.isArray(datos))
        return send(400, { error: "Petición inválida." });
      const body = datos;
      if (ruta.pathname === "/workspaces") {
        if (!spaces) return send(404, { error: "Ruta no encontrada." });
        return send(
          200,
          await spaces.link(
            /** @type {Parameters<typeof spaces.link>[0]} */ (body),
          ),
        );
      }
      const cat = await getToolCatalog();
      if (ruta.pathname === "/tools/profiles") {
        try {
          return send(
            200,
            await cat.updateProfile(
              /** @type {string} */ (body.profileId),
              body,
            ),
          );
        } catch (err) {
          throw new LauncherError(err.message, 400);
        }
      }
      const {
        billingAuthorized: _ignoredBilling,
        verifiedOperatorBillingGrant: _ignoredGrant,
        optInProbe = false,
        ...safeData
      } = body;
      try {
        if (optInProbe === true)
          await cat.runHealthChecks({
            optIn: true,
            cwd: safeData.cwd || null,
            probeTimeoutMs: 1500,
          });
        return send(200, await cat.resolveSkillsForTask(safeData));
      } catch (err) {
        throw new LauncherError(err.message, 400);
      }
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof LauncherError)
        return send(error.status, { error: error.message, seguro: true });
      if (error?.message?.startsWith("Conflicto de vínculos"))
        return send(409, { error: error.message, seguro: true });
      // A bug or an environment failure: leave a trail that never carries
      // credentials, headers or the text of a request.
      const texts = Object.values(datos ?? {}).filter(
        (value) => typeof value === "string",
      );
      try {
        register(
          JSON.stringify({
            evento: "lanzador.error",
            ruta: String(req.url ?? "").split("?")[0],
            metodo: req.method,
            nombre: error?.name,
            mensaje: redactDiagnostic(error?.message, { textos: texts }),
            pila: redactDiagnostic(error?.stack, { textos: texts }),
          }),
        );
      } catch {}
      send(500, { error: "No se pudo procesar la petición." });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await arrancar();
}
