import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { inferPhase } from "./phases.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstance } from "../service/instance.mjs";
import { openSessionRegistry } from "./sessions.mjs";
import { createExecutor } from "./executor.mjs";
import { openTeams } from "./teams.mjs";
import { createModelCatalog } from "./models.mjs";
import { watchConversations } from "./conversations.mjs";
import { openWorkspaces } from "./workspaces.mjs";
import { createUsage } from "./usage.mjs";
import { createItems } from "./items.mjs";
import { serveFlow } from "./flow.mjs";
import { createGit } from "./git.mjs";
import { createCheckpoints, createTracking } from "./checkpoints.mjs";
import { createPrClient } from "./pr.mjs";
import { createActions } from "./actions.mjs";
import { LauncherError } from "./errors.mjs";
import { redactDiagnostic } from "./diagnostics.mjs";
import { CAPABILITIES, REQUIREMENTS } from "./engines.mjs";
import { readLimits } from "./limits.mjs";
import {
  createProviderConversations,
  serveProviderConversation,
} from "./provider-conversations.mjs";
import { createToolCatalogStore } from "./tool-catalog.mjs";
import { openThreads } from "./threads/runtime.mjs";

/** @import { LauncherRequestBody, LauncherServerOptions } from "./launcher-server-types.d.ts" */
/** @import { ExecutionRequest } from "./types.d.ts" */

// Plain Errors thrown while checking a request; they are the caller's fault.
const VALIDATIONS = new Set([
  "Campo no modificable",
  "Conversación no disponible",
  "Encargo vacío",
  "Entrada inválida",
  "Entregable inválido",
  "Equipos no disponibles",
  "Estado inválido",
  "Líder inválido o ya asignado",
  "Mensaje inválido",
  "Miembro inválido",
  "Motor desconocido",
  "Motor inválido",
  "Motor remoto no disponible",
  "Motor u origen inválido",
  "Proyecto desconocido",
  "Repositorio no disponible",
  "Sesión hija inexistente",
  "Sesión inexistente",
  "Sesión inexistente.",
  "Sesión no activa",
  "Sesión no vinculable",
  "Sesión padre no activa",
  "Sesión sin equipo",
  "Tamaño inválido",
  "Tiempo de espera inválido",
  "Vínculo inválido",
]);

export async function arrancar(env = process.env) {
  const limits = readLimits(env);
  /** An absolute path the launcher cannot start without. */
  const requiredPath = (/** @type {string} */ name) => {
    const value = env[name];
    if (!value || !path.isAbsolute(value))
      throw new Error(`Falta configuración: ${name}`);
    return value;
  };
  const dataDir = requiredPath("SB_LANZADOR_DATA_DIR");
  const controlHashFile = requiredPath("SB_CONTROL_HASH_FILE");
  const hookHashFile = requiredPath("SB_HOOK_HASH_FILE");
  const projectsFile = requiredPath("SB_PROYECTOS_FILE");
  const port = Number(env.SB_LANZADOR_PORT ?? 8092);
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
  const hookHash = (await readFile(hookHashFile, "utf8")).trim();
  const release = await acquireInstance(dataDir);
  try {
    const registry = await openSessionRegistry(
      path.join(dataDir, "sesiones.json"),
      {
        retencionDias: limits.retencionDias,
      },
    );
    const teams = await openTeams(path.join(dataDir, "equipos"), {
      activo: (id) =>
        registry
          .leer()
          .some(
            (s) =>
              s.id === id && ["pendiente", "trabajando"].includes(s.estado),
          ),
      onChange: () => registry.notificar(),
    });
    const spaces = await openWorkspaces({
      archivo: path.join(dataDir, "espacios.json"),
      proyectos: projects,
      workspaces: path.join(dataDir, "workspaces"),
    });
    const gitExecutor = createGit({ env });
    const checkpoints = createCheckpoints({
      git: gitExecutor,
      dirIndices: path.join(dataDir, "indices-checkpoint"),
    });
    const tracking = createTracking({
      registro: registry,
      checkpoints,
      cwdDe: (s) =>
        s.directorio || (s.proyecto ? projects[s.proyecto] : null) || null,
    });
    const conversations = createProviderConversations({
      directory: path.join(dataDir, "conversations"),
    });
    const toolCatalog = await createToolCatalogStore({
      dataDir: dataDir,
      env,
    });
    // Threads (ADR 0010) live next to the session-era chat until it is removed.
    const threads = openThreads({
      env,
      dataDir,
      projects,
      git: gitExecutor.git,
      maxActive: limits.maxActivos,
      toolCatalog,
    });
    const executor = createExecutor({
      registro: registry,
      equipos: teams,
      proyectos: projects,
      espacios: spaces,
      env,
      seguimiento: tracking,
      conversations,
      toolCatalog,
      maxActivos: limits.maxActivos,
    });
    const catalog = createModelCatalog({ env });
    const sessionItems = createItems({ registro: registry, env });
    const actions = createActions({
      registro: registry,
      seguimiento: tracking,
      checkpoints,
      pr: createPrClient({ git: gitExecutor, info: checkpoints.info, env }),
      catalogo: catalog,
      proyectos: projects,
      items: sessionItems,
    });
    const unsubscribeConversations = env.HOME
      ? watchConversations({ registro: registry, env, proyectos: projects })
      : () => {};
    const server = createLauncherServer({
      registro: registry,
      ejecutor: executor,
      conversations,
      toolCatalog,
      catalogo: catalog,
      uso: createUsage({ env }),
      items: sessionItems,
      acciones: actions,
      equipos: teams,
      proyectos: projects,
      espacios: spaces,
      controlHash,
      hookHash,
      threads,
    });
    server.once("close", () => {
      unsubscribeConversations();
      void threads.close().catch(() => {});
      Promise.resolve(executor.cerrarTodo?.())
        .catch(() => {})
        .finally(() => {
          release().catch(() => {});
        });
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

// The catalog checks both what the caller asked for and what the approved
// manifest card fixes, so a card cannot carry an unavailable model.
/**
 * @param {Pick<ReturnType<typeof createModelCatalog>, "validar">} catalogo
 * @param {Pick<LauncherRequestBody, "motor" | "modelo" | "esfuerzo" | "manifest" | "memberId">} data
 * @param {{ coordinadora: boolean }} options
 */
async function validateSelection(catalogo, data, { coordinadora }) {
  await catalogo.validar(data.motor, data.modelo, data.esfuerzo);
  const team = Array.isArray(data.manifest?.team) ? data.manifest.team : [];
  const card = team.find(
    (c) =>
      c?.assigned !== false &&
      (data.memberId ? c.id === data.memberId : coordinadora && c.coordinator),
  );
  if (card && (card.motor ?? card.engine) === data.motor && card.model)
    await catalogo.validar(data.motor, card.model, card.effort || undefined);
}

/** @param {LauncherServerOptions} options */
export function createLauncherServer({
  registro: registry,
  ejecutor: executor,
  conversations,
  toolCatalog = null,
  catalogo: catalog = createModelCatalog({ env: {}, agy: async () => "" }),
  uso: usage = async () => ({}),
  items,
  acciones: actions,
  equipos: teams,
  proyectos: projects = {},
  espacios: spaces,
  controlHash,
  hookHash,
  threads = null,
  registrar: register = (line) => console.error(line),
}) {
  if (
    ![controlHash, hookHash].every((hash) => /^[a-f0-9]{64}$/i.test(hash)) ||
    controlHash === hookHash
  )
    throw new Error("Credenciales de control y hooks inválidas");
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
      // Always set for requests that reach an http.Server.
      const url = req.url ?? "/";
      const isHook = req.method === "POST" && url === "/eventos";
      if (
        !authorized(req.headers.authorization, isHook ? hookHash : controlHash)
      )
        return send(401, { error: "No autorizado." });
      const ruta = new URL(url, "http://127.0.0.1");
      if (threads && (await threads.http.handle(req, res, ruta))) return;
      const sessionAction =
        /^\/sesiones\/([a-f0-9-]{36})\/(diff|pr\/propuesta|revertir|pr\/redactar|pr)$/i.exec(
          ruta.pathname,
        );
      if (req.method === "GET" && url === "/capacidades")
        return send(200, { motores: CAPABILITIES, requisitos: REQUIREMENTS });
      if (req.method === "GET" && sessionAction && actions) {
        if (sessionAction[2] === "diff") {
          /** @param {string | null} v */
          const numero = (v) => (v === null ? undefined : Number(v));
          const desde = numero(ruta.searchParams.get("desde"));
          const hasta = ruta.searchParams.get("hasta");
          /** @param {number | undefined} v */
          const valid = (v) =>
            v === undefined || (Number.isInteger(v) && v >= 1);
          if (
            !valid(desde) ||
            !(hasta === null || hasta === "actual" || valid(Number(hasta)))
          )
            throw new LauncherError("Rango de cambios inválido.", 400);
          return send(
            200,
            await actions.diff(
              sessionAction[1],
              desde,
              hasta === null || hasta === "actual" ? undefined : Number(hasta),
            ),
          );
        }
        if (sessionAction[2] === "pr/propuesta")
          return send(200, await actions.propuesta(sessionAction[1]));
      }
      if (req.method === "GET" && url === "/estado")
        return send(
          200,
          actions
            ? await actions.listar()
            : registry
                .leer()
                .filter((s) => !s.eliminada)
                .map(({ terminal: _terminal, ...session }) => session),
        );
      if (req.method === "GET" && url === "/proyectos")
        return send(200, Object.keys(projects));
      if (req.method === "GET" && url === "/modelos")
        return send(200, await catalog.modelos());
      if (req.method === "GET" && url === "/uso")
        return send(200, await usage());
      if (req.method === "GET" && url === "/espacios" && spaces)
        return send(200, spaces.leer());
      if (req.method === "GET" && ruta.pathname === "/herramientas/catalogo") {
        const cat = await getToolCatalog();
        if (ruta.searchParams.get("probe") === "true") {
          await cat.runHealthChecks({ optIn: true, probeTimeoutMs: 1500 });
        }
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
      const terminalRoute = /^\/sesiones\/([a-f0-9-]{36})\/terminal$/.exec(url);
      const flowRoute = /^\/sesiones\/([a-f0-9-]{36})\/stream$/.exec(url);
      const conversationRoute =
        /^\/sesiones\/([a-f0-9-]{36})\/conversation(?:\/(answer|messages|queue|queue\/cancel|shutdown))?$/.exec(
          ruta.pathname,
        );
      if (
        req.method === "GET" &&
        conversationRoute &&
        !conversationRoute[2] &&
        conversations
      )
        return await serveProviderConversation({
          res,
          id: conversationRoute[1],
          conversations,
          registro: registry,
        });
      if (
        req.method === "GET" &&
        conversationRoute &&
        conversationRoute[2] === "queue" &&
        conversations
      ) {
        return send(200, {
          queue: await conversations.listQueue(conversationRoute[1]),
        });
      }
      const conversationArtifactRoute =
        /^\/sesiones\/([a-f0-9-]{36})\/conversation\/artifacts\/([a-f0-9-]{36})$/.exec(
          ruta.pathname,
        );
      if (req.method === "GET" && conversationArtifactRoute && conversations) {
        const session = registry
          .leer()
          .find((s) => s.id === conversationArtifactRoute[1] && !s.eliminada);
        if (!session?.structured) {
          throw new LauncherError("Conversación no disponible.", 404);
        }
        const { artifact, buffer } = await conversations.readArtifact(
          session.id,
          conversationArtifactRoute[2],
        );
        const safeName = String(artifact.fileName || "artifact.bin")
          .replace(/[^\x20-\x7e]/g, "_")
          .replace(/"/g, "");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": buffer.length,
          "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName || "artifact.bin")}`,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Artifact-Id": artifact.id,
          "X-Artifact-Version": String(artifact.version),
          "X-Artifact-Sha256": artifact.sha256 || "",
          "X-Artifact-Author": artifact.authorId || "",
          "X-Artifact-FileRef": encodeURIComponent(artifact.fileRef || ""),
          "X-Artifact-FileName": encodeURIComponent(artifact.fileName || ""),
        });
        res.end(buffer);
        return;
      }
      if (req.method === "GET" && flowRoute)
        return serveFlow({
          res,
          id: flowRoute[1],
          ejecutor: executor,
          registro: registry,
          items,
        });
      if (req.method === "GET" && url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const dejar = registry.subscribe(() => res.write("data: changed\n\n"));
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          25000,
        );
        heartbeat.unref();
        res.on("close", () => {
          clearInterval(heartbeat);
          dejar();
        });
        return;
      }
      const cancelar =
        req.method === "POST" &&
        /^\/sesiones\/([a-f0-9-]+)\/cancelar$/i.exec(url);
      if (cancelar) {
        await executor.cancelar(cancelar[1]);
        return send(202, { ok: true });
      }
      const remove =
        req.method === "POST" &&
        /^\/sesiones\/([a-f0-9-]{36})\/eliminar$/i.exec(url);
      if (remove) return send(200, await executor.eliminar(remove[1]));
      const teamActions = [
        "encargar",
        "esperar",
        "estado",
        "mensaje",
        "bandeja",
        "entregar",
        "integrar",
      ];
      const teamAction =
        url.startsWith("/equipo/") && teamActions.includes(url.slice(8))
          ? url.slice(8)
          : null;
      if (
        req.method !== "POST" ||
        (![
          "/sesiones",
          "/eventos",
          "/espacios",
          "/herramientas/perfiles",
          "/herramientas/skills/resolver",
        ].includes(url) &&
          !teamAction &&
          !terminalRoute &&
          !conversationRoute &&
          !(sessionAction && actions))
      )
        return send(404, { error: "Ruta no encontrada." });
      // Chunks stay as bytes until the end: a multi-byte character split
      // between two chunks must not be decoded (and broken) separately.
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        const buffer = Buffer.from(part);
        bytes += buffer.length;
        if (bytes > 512000)
          return send(413, { error: "Petición demasiado grande." });
        parts.push(buffer);
      }
      const cuerpo = Buffer.concat(parts).toString("utf8");
      try {
        datos = JSON.parse(cuerpo);
      } catch {
        return send(400, { error: "JSON inválido." });
      }
      if (!datos || typeof datos !== "object" || Array.isArray(datos))
        return send(400, { error: "Petición inválida." });
      // Validated as a plain object above; a const keeps that inside callbacks.
      const body = datos;
      if (url === "/espacios" && spaces)
        return send(
          200,
          await spaces.vincular(
            /** @type {Parameters<typeof spaces.vincular>[0]} */ (body),
          ),
        );
      if (url === "/herramientas/perfiles") {
        const cat = await getToolCatalog();
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
      if (url === "/herramientas/skills/resolver") {
        const cat = await getToolCatalog();
        const {
          billingAuthorized: _ignoredBilling,
          verifiedOperatorBillingGrant: _ignoredGrant,
          optInProbe = false,
          ...safeData
        } = body && typeof body === "object" ? body : {};
        try {
          if (optInProbe === true) {
            await cat.runHealthChecks({
              optIn: true,
              cwd: safeData.cwd || null,
              probeTimeoutMs: 1500,
            });
          }
          return send(200, await cat.resolveSkillsForTask(safeData));
        } catch (err) {
          throw new LauncherError(err.message, 400);
        }
      }
      if (conversationRoute && conversationRoute[2] && conversations) {
        const session = registry
          .leer()
          .find((s) => s.id === conversationRoute[1] && !s.eliminada);
        if (!session?.structured)
          throw new LauncherError("Conversación no disponible.", 404);
        if (conversationRoute[2] === "answer")
          return send(
            200,
            await conversations.answer(
              session.id,
              /** @type {Parameters<typeof conversations.answer>[1]} */ (body),
            ),
          );
        if (conversationRoute[2] === "messages")
          return send(200, await executor.enviarMensaje(session.id, body));
        if (conversationRoute[2] === "queue/cancel")
          return send(
            200,
            await executor.cancelarCola(
              session.id,
              /** @type {string} */ (body.clientMessageId),
            ),
          );
        if (conversationRoute[2] === "shutdown")
          return send(
            200,
            await executor.cerrarConexion(
              session.id,
              typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : undefined,
            ),
          );
      }
      if (sessionAction && actions) {
        const id = sessionAction[1];
        if (sessionAction[2] === "revertir")
          return send(
            200,
            await actions.revertir(id, /** @type {number} */ (body.n)),
          );
        if (sessionAction[2] === "pr")
          return send(200, await actions.pr(id, body));
        if (sessionAction[2] === "pr/redactar")
          return send(200, await actions.redactar(id));
        return send(404, { error: "Ruta no encontrada." });
      }
      if (terminalRoute) {
        if (body.interrumpir === true && actions) {
          const sesion = registry.leer().find((s) => s.id === terminalRoute[1]);
          if (sesion && !(await actions.capacidades(sesion))?.interrumpir)
            throw new LauncherError(
              "Esta sesión no tiene terminal en marcha para interrumpir el turno.",
            );
        }
        return send(200, executor.entrada(terminalRoute[1], body));
      }
      if (teamAction) {
        const sesion = registry
          .leer()
          .find((s) => s.id === body.sesion && s.estado === "trabajando");
        /** @type {Record<string, string>} */
        const actors = {
          claude: "ambar",
          codex: "menta",
          agy: "lira",
          deepseek: "marina",
        };
        const actor = actors[sesion?.motor ?? ""];
        if (!teams || !sesion || !actor || body.actor !== actor)
          return send(403, { error: "Sesión no activa." });
        let result;
        if (teamAction === "encargar") {
          await validateSelection(catalog, body, { coordinadora: false });
          result = await executor.encargarHija(sesion.id, {
            id: body.id || null,
            motor: /** @type {string} */ (body.motor),
            proyecto: body.proyecto,
            brief: /** @type {string} */ (body.brief),
            modelo: body.modelo,
            esfuerzo: body.esfuerzo,
            toolProfileId: body.toolProfileId || null,
            effectiveProfile: body.effectiveProfile || null,
            skillIds: Array.isArray(body.skillIds) ? body.skillIds : null,
            capabilityToken: body.capabilityToken || null,
            billingGrantVerified: false,
            ...(body.memberId !== undefined ? { memberId: body.memberId } : {}),
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.responsibility !== undefined
              ? { responsibility: body.responsibility }
              : {}),
            ...(body.workOrderId !== undefined
              ? { workOrderId: body.workOrderId }
              : {}),
            ...(body.manifest !== undefined ? { manifest: body.manifest } : {}),
            ...(body.manifestSha256 !== undefined
              ? { manifestSha256: body.manifestSha256 }
              : {}),
            ...(body.requestId !== undefined
              ? { requestId: body.requestId }
              : {}),
            ...(body.enqueueIfFull !== undefined
              ? { enqueueIfFull: body.enqueueIfFull }
              : {}),
          });
        }
        if (teamAction === "esperar")
          result = await executor.esperarHija(
            sesion.id,
            /** @type {string} */ (body.id),
            body.timeout,
          );
        if (teamAction === "estado") result = teams.estado(sesion.id);
        if (teamAction === "mensaje")
          result = await teams.mensaje(
            sesion.id,
            /** @type {string} */ (body.para),
            /** @type {string} */ (body.texto),
          );
        if (teamAction === "bandeja") result = teams.bandeja(sesion.id);
        if (teamAction === "entregar") {
          const hasExtraFields =
            body.ruta !== undefined ||
            body.baseSha256 !== undefined ||
            body.archivos !== undefined;
          result = hasExtraFields
            ? await teams.entregar(sesion.id, {
                titulo: /** @type {string} */ (body.titulo),
                contenido: body.contenido,
                ruta: body.ruta,
                baseSha256: body.baseSha256,
                archivos: body.archivos,
              })
            : await teams.entregar(
                sesion.id,
                /** @type {string} */ (body.titulo),
                body.contenido ?? undefined,
              );
        }
        if (teamAction === "integrar") {
          let resolvedTarget =
            sesion.directorio ||
            (sesion.proyecto ? projects[sesion.proyecto] : null) ||
            null;
          if (typeof body.targetDir === "string" && body.targetDir.trim()) {
            const baseAllowed = resolvedTarget
              ? path.resolve(resolvedTarget)
              : null;
            const requested = path.resolve(body.targetDir.trim());
            if (
              baseAllowed &&
              (requested === baseAllowed ||
                requested.startsWith(baseAllowed + path.sep))
            ) {
              resolvedTarget = requested;
            } else {
              throw new LauncherError(
                "Directorio destino de integración no autorizado.",
                403,
              );
            }
          }
          result = await teams.integrar(sesion.id, {
            entregableIds: body.entregableIds,
            targetDir: resolvedTarget,
            resoluciones: body.resoluciones,
          });
        }
        // Marks the sender so the room can animate a real handoff; ids only.
        if (["mensaje", "entregar"].includes(teamAction)) {
          try {
            const para =
              teamAction === "mensaje"
                ? body.para
                : teams.estado(sesion.id).lider;
            if (para && para !== sesion.id)
              await registry.actualizar(sesion.id, {
                relevo: {
                  id: /** @type {{ id: string }} */ (result).id,
                  tipo: teamAction === "mensaje" ? "mensaje" : "entregable",
                  para,
                },
              });
          } catch {
            /* the animation never blocks a team tool */
          }
        }
        return send(200, result);
      }
      if (isHook) {
        const sesion = registry
          .leer()
          .find(
            (s) =>
              s.id === body.id &&
              ["pendiente", "trabajando"].includes(s.estado),
          );
        if (!sesion) return send(404, { error: "Sesión no activa." });
        if (
          typeof body.herramienta !== "string" ||
          body.herramienta.length > 100
        )
          return send(400, { error: "Herramienta inválida." });
        const phase = inferPhase(body.herramienta);
        if (phase)
          await registry.actualizar(sesion.id, {
            fase: phase,
            ultimaAccion: {
              investigar: "Consultando información",
              planificar: "Planificando",
              programar: "Trabajando con archivos",
              revisar: "Revisando",
            }[phase],
          });
        return send(204);
      }
      if (
        /** @type {const} */ (["modelo", "esfuerzo"]).some(
          (k) => body[k] !== undefined && typeof body[k] !== "string",
        )
      )
        return send(400, { error: "Petición inválida." });
      if (body.continuar) {
        const previous = actions
          ? registry.leer().find((s) => s.id === body.continuar)
          : null;
        // previa is only looked up when acciones exists.
        if (
          previous &&
          actions &&
          !(await actions.capacidades(previous))?.continuar
        )
          throw new LauncherError(
            "Este agente no permite continuar esta conversación; abre una nueva.",
          );
      }
      if (body.continuar)
        return send(
          202,
          await executor.continuar(
            /** @type {string} */ (body.continuar),
            /** @type {string} */ (body.brief),
          ),
        );
      if (
        body.billingAuthorized === true &&
        body.billingGrantVerified !== true
      ) {
        return send(403, {
          error:
            "La autorización de gasto requiere concesión verificada del operador.",
          seguro: true,
        });
      }
      await validateSelection(catalog, body, { coordinadora: true });
      return send(
        202,
        await executor.encargar(
          /** @type {ExecutionRequest} */ ({
            ...body,
            billingGrantVerified: body.billingGrantVerified === true,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof LauncherError && !res.headersSent)
        return send(error.status, { error: error.message, seguro: true });
      const known = new Set([
        "Conflicto de vínculos; actualiza e inténtalo de nuevo",
        "Modelo no disponible",
        "Saldo DeepSeek insuficiente",
        "Saldo DeepSeek no disponible",
        "Límite de sesiones activas",
        "Límite del equipo alcanzado",
        "Profundidad máxima alcanzada",
        "Elige otro proveedor",
        "Detén la sesión antes de eliminarla",
        "Terminal no disponible",
      ]);
      if (res.headersSent) return res.end();
      const generic = "No se pudo procesar la petición.";
      const conflict = error?.message?.startsWith("Conflicto de vínculos");
      if (known.has(error?.message) || conflict)
        return send(conflict ? 409 : 400, {
          error: known.has(error?.message) ? error.message : generic,
        });
      // Rejections of the request itself keep answering 400 without a trace.
      if (VALIDATIONS.has(error?.message)) return send(400, { error: generic });
      // Anything else is a bug or an environment failure: leave a trail that
      // never carries credentials, headers or the text of an assignment.
      try {
        register(
          JSON.stringify({
            evento: "lanzador.error",
            ruta: String(req.url ?? "").split("?")[0],
            metodo: req.method,
            nombre: error?.name,
            mensaje: redactDiagnostic(error?.message, {
              textos: Object.values(datos ?? {}).filter(
                (value) => typeof value === "string",
              ),
            }),
            pila: redactDiagnostic(error?.stack, {
              textos: Object.values(datos ?? {}).filter(
                (value) => typeof value === "string",
              ),
            }),
          }),
        );
      } catch {}
      send(500, { error: generic });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await arrancar();
}
