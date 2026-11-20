import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { inferirFase } from "./phases.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstance } from "../service/instance.mjs";
import { abrirRegistro } from "./sessions.mjs";
import { crearEjecutor } from "./executor.mjs";
import { abrirEquipos } from "./teams.mjs";
import { crearCatalogo } from "./models.mjs";
import { observarConversaciones } from "./conversations.mjs";
import { abrirEspacios } from "./workspaces.mjs";
import { crearUso } from "./usage.mjs";
import { crearItems } from "./items.mjs";
import { servirFlujo } from "./flow.mjs";
import { crearGit } from "./git.mjs";
import { crearCheckpoints, crearSeguimiento } from "./checkpoints.mjs";
import { crearPr } from "./pr.mjs";
import { crearAcciones } from "./actions.mjs";
import { ErrorLanzador } from "./errors.mjs";
import { ocultarDiagnostico } from "./diagnostics.mjs";
import { CAPACIDADES, REQUISITOS } from "./engines.mjs";
import { readLimits } from "./limits.mjs";
import {
  createProviderConversations,
  serveProviderConversation,
} from "./provider-conversations.mjs";
import { createToolCatalogStore } from "./tool-catalog.mjs";

/** @import { LauncherRequestBody, LauncherServerOptions } from "./launcher-server-types.d.ts" */
/** @import { ExecutionRequest } from "./types.d.ts" */

// Plain Errors thrown while checking a request; they are the caller's fault.
const VALIDACIONES = new Set([
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
  const requiredPath = (/** @type {string} */ nombre) => {
    const value = env[nombre];
    if (!value || !path.isAbsolute(value))
      throw new Error(`Falta configuración: ${nombre}`);
    return value;
  };
  const dataDir = requiredPath("SB_LANZADOR_DATA_DIR");
  const controlHashFile = requiredPath("SB_CONTROL_HASH_FILE");
  const hookHashFile = requiredPath("SB_HOOK_HASH_FILE");
  const proyectosFile = requiredPath("SB_PROYECTOS_FILE");
  const puerto = Number(env.SB_LANZADOR_PORT ?? 8092);
  if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535)
    throw new Error("Puerto inválido");
  const proyectos = JSON.parse(await readFile(proyectosFile, "utf8"));
  if (!proyectos || Array.isArray(proyectos) || typeof proyectos !== "object")
    throw new Error("Proyectos inválidos");
  for (const [nombre, directorio] of Object.entries(proyectos)) {
    if (
      !/^[a-z0-9_-]+$/i.test(nombre) ||
      typeof directorio !== "string" ||
      !path.isAbsolute(directorio)
    )
      throw new Error("Proyecto inválido");
    proyectos[nombre] = await realpath(directorio);
    if (!(await stat(proyectos[nombre])).isDirectory())
      throw new Error("Proyecto no es directorio");
  }
  const controlHash = (await readFile(controlHashFile, "utf8")).trim();
  const hookHash = (await readFile(hookHashFile, "utf8")).trim();
  const soltar = await acquireInstance(dataDir);
  try {
    const registro = await abrirRegistro(path.join(dataDir, "sesiones.json"), {
      retencionDias: limits.retencionDias,
    });
    const equipos = await abrirEquipos(path.join(dataDir, "equipos"), {
      activo: (id) =>
        registro
          .leer()
          .some(
            (s) =>
              s.id === id && ["pendiente", "trabajando"].includes(s.estado),
          ),
      onChange: () => registro.notificar(),
    });
    const espacios = await abrirEspacios({
      archivo: path.join(dataDir, "espacios.json"),
      proyectos,
      workspaces: path.join(dataDir, "workspaces"),
    });
    const ejecutorGit = crearGit({ env });
    const checkpoints = crearCheckpoints({
      git: ejecutorGit,
      dirIndices: path.join(dataDir, "indices-checkpoint"),
    });
    const seguimiento = crearSeguimiento({
      registro,
      checkpoints,
      cwdDe: (s) =>
        s.directorio || (s.proyecto ? proyectos[s.proyecto] : null) || null,
    });
    const conversations = createProviderConversations({
      directory: path.join(dataDir, "conversations"),
    });
    const toolCatalog = await createToolCatalogStore({
      dataDir: dataDir,
      env,
    });
    const ejecutor = crearEjecutor({
      registro,
      equipos,
      proyectos,
      espacios,
      env,
      seguimiento,
      conversations,
      toolCatalog,
      maxActivos: limits.maxActivos,
    });
    const catalogo = crearCatalogo({ env });
    const itemsSesion = crearItems({ registro, env });
    const acciones = crearAcciones({
      registro,
      seguimiento,
      checkpoints,
      pr: crearPr({ git: ejecutorGit, info: checkpoints.info, env }),
      catalogo,
      proyectos,
      items: itemsSesion,
    });
    const dejarConversaciones = env.HOME
      ? observarConversaciones({ registro, env, proyectos })
      : () => {};
    const servidor = crearServidor({
      registro,
      ejecutor,
      conversations,
      toolCatalog,
      catalogo,
      uso: crearUso({ env }),
      items: itemsSesion,
      acciones,
      equipos,
      proyectos,
      espacios,
      controlHash,
      hookHash,
    });
    servidor.once("close", () => {
      dejarConversaciones();
      Promise.resolve(ejecutor.cerrarTodo?.())
        .catch(() => {})
        .finally(() => {
          soltar().catch(() => {});
        });
    });
    await new Promise((resolve, reject) => {
      servidor.once("error", reject);
      servidor.listen(puerto, "127.0.0.1", () => resolve(undefined));
    });
    return servidor;
  } catch (error) {
    await soltar();
    throw error;
  }
}

/**
 * @param {unknown} header
 * @param {string} hash
 */
function autorizado(header, hash) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const esperado = Buffer.from(hash, "hex");
  const recibido = createHash("sha256").update(header.slice(7)).digest();
  return (
    esperado.length === recibido.length && timingSafeEqual(esperado, recibido)
  );
}

// The catalog checks both what the caller asked for and what the approved
// manifest card fixes, so a card cannot carry an unavailable model.
/**
 * @param {Pick<ReturnType<typeof crearCatalogo>, "validar">} catalogo
 * @param {Pick<LauncherRequestBody, "motor" | "modelo" | "esfuerzo" | "manifest" | "memberId">} datos
 * @param {{ coordinadora: boolean }} options
 */
async function validarSeleccion(catalogo, datos, { coordinadora }) {
  await catalogo.validar(datos.motor, datos.modelo, datos.esfuerzo);
  const team = Array.isArray(datos.manifest?.team) ? datos.manifest.team : [];
  const card = team.find(
    (c) =>
      c?.assigned !== false &&
      (datos.memberId
        ? c.id === datos.memberId
        : coordinadora && c.coordinator),
  );
  if (card && (card.motor ?? card.engine) === datos.motor && card.model)
    await catalogo.validar(datos.motor, card.model, card.effort || undefined);
}

/** @param {LauncherServerOptions} options */
export function crearServidor({
  registro,
  ejecutor,
  conversations,
  toolCatalog = null,
  catalogo = crearCatalogo({ env: {}, agy: async () => "" }),
  uso = async () => ({}),
  items,
  acciones,
  equipos,
  proyectos = {},
  espacios,
  controlHash,
  hookHash,
  registrar = (linea) => console.error(linea),
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
    const enviar = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    try {
      // Always set for requests that reach an http.Server.
      const url = req.url ?? "/";
      const esHook = req.method === "POST" && url === "/eventos";
      if (
        !autorizado(req.headers.authorization, esHook ? hookHash : controlHash)
      )
        return enviar(401, { error: "No autorizado." });
      const ruta = new URL(url, "http://127.0.0.1");
      const accionSesion =
        /^\/sesiones\/([a-f0-9-]{36})\/(diff|pr\/propuesta|revertir|pr\/redactar|pr)$/i.exec(
          ruta.pathname,
        );
      if (req.method === "GET" && url === "/capacidades")
        return enviar(200, { motores: CAPACIDADES, requisitos: REQUISITOS });
      if (req.method === "GET" && accionSesion && acciones) {
        if (accionSesion[2] === "diff") {
          /** @param {string | null} v */
          const numero = (v) => (v === null ? undefined : Number(v));
          const desde = numero(ruta.searchParams.get("desde"));
          const hasta = ruta.searchParams.get("hasta");
          /** @param {number | undefined} v */
          const valido = (v) =>
            v === undefined || (Number.isInteger(v) && v >= 1);
          if (
            !valido(desde) ||
            !(hasta === null || hasta === "actual" || valido(Number(hasta)))
          )
            throw new ErrorLanzador("Rango de cambios inválido.", 400);
          return enviar(
            200,
            await acciones.diff(
              accionSesion[1],
              desde,
              hasta === null || hasta === "actual" ? undefined : Number(hasta),
            ),
          );
        }
        if (accionSesion[2] === "pr/propuesta")
          return enviar(200, await acciones.propuesta(accionSesion[1]));
      }
      if (req.method === "GET" && url === "/estado")
        return enviar(
          200,
          acciones
            ? await acciones.listar()
            : registro
                .leer()
                .filter((s) => !s.eliminada)
                .map(({ terminal: _terminal, ...session }) => session),
        );
      if (req.method === "GET" && url === "/proyectos")
        return enviar(200, Object.keys(proyectos));
      if (req.method === "GET" && url === "/modelos")
        return enviar(200, await catalogo.modelos());
      if (req.method === "GET" && url === "/uso")
        return enviar(200, await uso());
      if (req.method === "GET" && url === "/espacios" && espacios)
        return enviar(200, espacios.leer());
      if (req.method === "GET" && ruta.pathname === "/herramientas/catalogo") {
        const cat = await getToolCatalog();
        if (ruta.searchParams.get("probe") === "true") {
          await cat.runHealthChecks({ optIn: true, probeTimeoutMs: 1500 });
        }
        return enviar(
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
      const flujoRoute = /^\/sesiones\/([a-f0-9-]{36})\/stream$/.exec(url);
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
          registro,
        });
      if (
        req.method === "GET" &&
        conversationRoute &&
        conversationRoute[2] === "queue" &&
        conversations
      ) {
        return enviar(200, {
          queue: await conversations.listQueue(conversationRoute[1]),
        });
      }
      const conversationArtifactRoute =
        /^\/sesiones\/([a-f0-9-]{36})\/conversation\/artifacts\/([a-f0-9-]{36})$/.exec(
          ruta.pathname,
        );
      if (req.method === "GET" && conversationArtifactRoute && conversations) {
        const session = registro
          .leer()
          .find((s) => s.id === conversationArtifactRoute[1] && !s.eliminada);
        if (!session?.structured) {
          throw new ErrorLanzador("Conversación no disponible.", 404);
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
      if (req.method === "GET" && flujoRoute)
        return servirFlujo({
          res,
          id: flujoRoute[1],
          ejecutor,
          registro,
          items,
        });
      if (req.method === "GET" && url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const dejar = registro.subscribe(() => res.write("data: changed\n\n"));
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
        await ejecutor.cancelar(cancelar[1]);
        return enviar(202, { ok: true });
      }
      const eliminar =
        req.method === "POST" &&
        /^\/sesiones\/([a-f0-9-]{36})\/eliminar$/i.exec(url);
      if (eliminar) return enviar(200, await ejecutor.eliminar(eliminar[1]));
      const accionesEquipo = [
        "encargar",
        "esperar",
        "estado",
        "mensaje",
        "bandeja",
        "entregar",
        "integrar",
      ];
      const accionEquipo =
        url.startsWith("/equipo/") && accionesEquipo.includes(url.slice(8))
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
          !accionEquipo &&
          !terminalRoute &&
          !conversationRoute &&
          !(accionSesion && acciones))
      )
        return enviar(404, { error: "Ruta no encontrada." });
      // Chunks stay as bytes until the end: a multi-byte character split
      // between two chunks must not be decoded (and broken) separately.
      const partes = [];
      let bytes = 0;
      for await (const parte of req) {
        const buffer = Buffer.from(parte);
        bytes += buffer.length;
        if (bytes > 512000)
          return enviar(413, { error: "Petición demasiado grande." });
        partes.push(buffer);
      }
      const cuerpo = Buffer.concat(partes).toString("utf8");
      try {
        datos = JSON.parse(cuerpo);
      } catch {
        return enviar(400, { error: "JSON inválido." });
      }
      if (!datos || typeof datos !== "object" || Array.isArray(datos))
        return enviar(400, { error: "Petición inválida." });
      // Validated as a plain object above; a const keeps that inside callbacks.
      const body = datos;
      if (url === "/espacios" && espacios)
        return enviar(
          200,
          await espacios.vincular(
            /** @type {Parameters<typeof espacios.vincular>[0]} */ (body),
          ),
        );
      if (url === "/herramientas/perfiles") {
        const cat = await getToolCatalog();
        try {
          return enviar(
            200,
            await cat.updateProfile(
              /** @type {string} */ (body.profileId),
              body,
            ),
          );
        } catch (err) {
          throw new ErrorLanzador(err.message, 400);
        }
      }
      if (url === "/herramientas/skills/resolver") {
        const cat = await getToolCatalog();
        const {
          billingAuthorized: _ignoredBilling,
          verifiedOperatorBillingGrant: _ignoredGrant,
          optInProbe = false,
          ...safeDatos
        } = body && typeof body === "object" ? body : {};
        try {
          if (optInProbe === true) {
            await cat.runHealthChecks({
              optIn: true,
              cwd: safeDatos.cwd || null,
              probeTimeoutMs: 1500,
            });
          }
          return enviar(200, await cat.resolveSkillsForTask(safeDatos));
        } catch (err) {
          throw new ErrorLanzador(err.message, 400);
        }
      }
      if (conversationRoute && conversationRoute[2] && conversations) {
        const session = registro
          .leer()
          .find((s) => s.id === conversationRoute[1] && !s.eliminada);
        if (!session?.structured)
          throw new ErrorLanzador("Conversación no disponible.", 404);
        if (conversationRoute[2] === "answer")
          return enviar(
            200,
            await conversations.answer(
              session.id,
              /** @type {Parameters<typeof conversations.answer>[1]} */ (body),
            ),
          );
        if (conversationRoute[2] === "messages")
          return enviar(200, await ejecutor.enviarMensaje(session.id, body));
        if (conversationRoute[2] === "queue/cancel")
          return enviar(
            200,
            await ejecutor.cancelarCola(
              session.id,
              /** @type {string} */ (body.clientMessageId),
            ),
          );
        if (conversationRoute[2] === "shutdown")
          return enviar(
            200,
            await ejecutor.cerrarConexion(
              session.id,
              typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : undefined,
            ),
          );
      }
      if (accionSesion && acciones) {
        const id = accionSesion[1];
        if (accionSesion[2] === "revertir")
          return enviar(
            200,
            await acciones.revertir(id, /** @type {number} */ (body.n)),
          );
        if (accionSesion[2] === "pr")
          return enviar(200, await acciones.pr(id, body));
        if (accionSesion[2] === "pr/redactar")
          return enviar(200, await acciones.redactar(id));
        return enviar(404, { error: "Ruta no encontrada." });
      }
      if (terminalRoute) {
        if (body.interrumpir === true && acciones) {
          const sesion = registro.leer().find((s) => s.id === terminalRoute[1]);
          if (sesion && !(await acciones.capacidades(sesion))?.interrumpir)
            throw new ErrorLanzador(
              "Esta sesión no tiene terminal en marcha para interrumpir el turno.",
            );
        }
        return enviar(200, ejecutor.entrada(terminalRoute[1], body));
      }
      if (accionEquipo) {
        const sesion = registro
          .leer()
          .find((s) => s.id === body.sesion && s.estado === "trabajando");
        /** @type {Record<string, string>} */
        const actores = {
          claude: "ambar",
          codex: "menta",
          agy: "lira",
          deepseek: "marina",
        };
        const actor = actores[sesion?.motor ?? ""];
        if (!equipos || !sesion || !actor || body.actor !== actor)
          return enviar(403, { error: "Sesión no activa." });
        let resultado;
        if (accionEquipo === "encargar") {
          await validarSeleccion(catalogo, body, { coordinadora: false });
          resultado = await ejecutor.encargarHija(sesion.id, {
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
        if (accionEquipo === "esperar")
          resultado = await ejecutor.esperarHija(
            sesion.id,
            /** @type {string} */ (body.id),
            body.timeout,
          );
        if (accionEquipo === "estado") resultado = equipos.estado(sesion.id);
        if (accionEquipo === "mensaje")
          resultado = await equipos.mensaje(
            sesion.id,
            /** @type {string} */ (body.para),
            /** @type {string} */ (body.texto),
          );
        if (accionEquipo === "bandeja") resultado = equipos.bandeja(sesion.id);
        if (accionEquipo === "entregar") {
          const tieneCamposExtra =
            body.ruta !== undefined ||
            body.baseSha256 !== undefined ||
            body.archivos !== undefined;
          resultado = tieneCamposExtra
            ? await equipos.entregar(sesion.id, {
                titulo: /** @type {string} */ (body.titulo),
                contenido: body.contenido,
                ruta: body.ruta,
                baseSha256: body.baseSha256,
                archivos: body.archivos,
              })
            : await equipos.entregar(
                sesion.id,
                /** @type {string} */ (body.titulo),
                body.contenido ?? undefined,
              );
        }
        if (accionEquipo === "integrar") {
          let resolvedTarget =
            sesion.directorio ||
            (sesion.proyecto ? proyectos[sesion.proyecto] : null) ||
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
              throw new ErrorLanzador(
                "Directorio destino de integración no autorizado.",
                403,
              );
            }
          }
          resultado = await equipos.integrar(sesion.id, {
            entregableIds: body.entregableIds,
            targetDir: resolvedTarget,
            resoluciones: body.resoluciones,
          });
        }
        // Marks the sender so the room can animate a real handoff; ids only.
        if (["mensaje", "entregar"].includes(accionEquipo)) {
          try {
            const para =
              accionEquipo === "mensaje"
                ? body.para
                : equipos.estado(sesion.id).lider;
            if (para && para !== sesion.id)
              await registro.actualizar(sesion.id, {
                relevo: {
                  id: /** @type {{ id: string }} */ (resultado).id,
                  tipo: accionEquipo === "mensaje" ? "mensaje" : "entregable",
                  para,
                },
              });
          } catch {
            /* the animation never blocks a team tool */
          }
        }
        return enviar(200, resultado);
      }
      if (esHook) {
        const sesion = registro
          .leer()
          .find(
            (s) =>
              s.id === body.id &&
              ["pendiente", "trabajando"].includes(s.estado),
          );
        if (!sesion) return enviar(404, { error: "Sesión no activa." });
        if (
          typeof body.herramienta !== "string" ||
          body.herramienta.length > 100
        )
          return enviar(400, { error: "Herramienta inválida." });
        const fase = inferirFase(body.herramienta);
        if (fase)
          await registro.actualizar(sesion.id, {
            fase,
            ultimaAccion: {
              investigar: "Consultando información",
              planificar: "Planificando",
              programar: "Trabajando con archivos",
              revisar: "Revisando",
            }[fase],
          });
        return enviar(204);
      }
      if (
        /** @type {const} */ (["modelo", "esfuerzo"]).some(
          (k) => body[k] !== undefined && typeof body[k] !== "string",
        )
      )
        return enviar(400, { error: "Petición inválida." });
      if (body.continuar) {
        const previa = acciones
          ? registro.leer().find((s) => s.id === body.continuar)
          : null;
        // previa is only looked up when acciones exists.
        if (
          previa &&
          acciones &&
          !(await acciones.capacidades(previa))?.continuar
        )
          throw new ErrorLanzador(
            "Este agente no permite continuar esta conversación; abre una nueva.",
          );
      }
      if (body.continuar)
        return enviar(
          202,
          await ejecutor.continuar(
            /** @type {string} */ (body.continuar),
            /** @type {string} */ (body.brief),
          ),
        );
      if (
        body.billingAuthorized === true &&
        body.billingGrantVerified !== true
      ) {
        return enviar(403, {
          error:
            "La autorización de gasto requiere concesión verificada del operador.",
          seguro: true,
        });
      }
      await validarSeleccion(catalogo, body, { coordinadora: true });
      return enviar(
        202,
        await ejecutor.encargar(
          /** @type {ExecutionRequest} */ ({
            ...body,
            billingGrantVerified: body.billingGrantVerified === true,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof ErrorLanzador && !res.headersSent)
        return enviar(error.status, { error: error.message, seguro: true });
      const conocidas = new Set([
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
      const generico = "No se pudo procesar la petición.";
      const conflicto = error?.message?.startsWith("Conflicto de vínculos");
      if (conocidas.has(error?.message) || conflicto)
        return enviar(conflicto ? 409 : 400, {
          error: conocidas.has(error?.message) ? error.message : generico,
        });
      // Rejections of the request itself keep answering 400 without a trace.
      if (VALIDACIONES.has(error?.message))
        return enviar(400, { error: generico });
      // Anything else is a bug or an environment failure: leave a trail that
      // never carries credentials, headers or the text of an assignment.
      try {
        registrar(
          JSON.stringify({
            evento: "lanzador.error",
            ruta: String(req.url ?? "").split("?")[0],
            metodo: req.method,
            nombre: error?.name,
            mensaje: ocultarDiagnostico(error?.message, {
              textos: Object.values(datos ?? {}).filter(
                (value) => typeof value === "string",
              ),
            }),
            pila: ocultarDiagnostico(error?.stack, {
              textos: Object.values(datos ?? {}).filter(
                (value) => typeof value === "string",
              ),
            }),
          }),
        );
      } catch {}
      enviar(500, { error: generico });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await arrancar();
}
