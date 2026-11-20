import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { inferirFase } from "./fases.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstance } from "../service/instance.mjs";
import { abrirRegistro } from "./sesiones.mjs";
import { crearEjecutor } from "./ejecucion.mjs";
import { abrirEquipos } from "./equipos.mjs";
import { crearCatalogo } from "./modelos.mjs";
import { observarConversaciones } from "./conversaciones.mjs";
import { abrirEspacios } from "./espacios.mjs";
import { crearUso } from "./uso.mjs";
import { crearItems } from "./items.mjs";
import { servirFlujo } from "./flujo.mjs";
import { crearGit } from "./git.mjs";
import { crearCheckpoints, crearSeguimiento } from "./checkpoints.mjs";
import { crearPr } from "./pr.mjs";
import { crearAcciones } from "./acciones.mjs";
import { ErrorLanzador } from "./errores.mjs";
import { ocultarDiagnostico } from "./diagnostico.mjs";
import { CAPACIDADES, REQUISITOS } from "./motores.mjs";
import { readLimits } from "./limits.mjs";
import {
  createProviderConversations,
  serveProviderConversation,
} from "./provider-conversations.mjs";
import { createToolCatalogStore } from "./catalogo-herramientas.mjs";

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
  for (const nombre of [
    "SB_LANZADOR_DATA_DIR",
    "SB_CONTROL_HASH_FILE",
    "SB_HOOK_HASH_FILE",
    "SB_PROYECTOS_FILE",
  ])
    if (!env[nombre] || !path.isAbsolute(env[nombre]))
      throw new Error(`Falta configuración: ${nombre}`);
  const puerto = Number(env.SB_LANZADOR_PORT ?? 8092);
  if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535)
    throw new Error("Puerto inválido");
  const proyectos = JSON.parse(await readFile(env.SB_PROYECTOS_FILE, "utf8"));
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
  const controlHash = (await readFile(env.SB_CONTROL_HASH_FILE, "utf8")).trim();
  const hookHash = (await readFile(env.SB_HOOK_HASH_FILE, "utf8")).trim();
  const soltar = await acquireInstance(env.SB_LANZADOR_DATA_DIR);
  try {
    const registro = await abrirRegistro(
      path.join(env.SB_LANZADOR_DATA_DIR, "sesiones.json"),
      { retencionDias: limits.retencionDias },
    );
    const equipos = await abrirEquipos(
      path.join(env.SB_LANZADOR_DATA_DIR, "equipos"),
      {
        activo: (id) =>
          registro
            .leer()
            .some(
              (s) =>
                s.id === id && ["pendiente", "trabajando"].includes(s.estado),
            ),
        onChange: () => registro.notificar(),
      },
    );
    const espacios = await abrirEspacios({
      archivo: path.join(env.SB_LANZADOR_DATA_DIR, "espacios.json"),
      proyectos,
      workspaces: path.join(env.SB_LANZADOR_DATA_DIR, "workspaces"),
    });
    const ejecutorGit = crearGit({ env });
    const checkpoints = crearCheckpoints({
      git: ejecutorGit,
      dirIndices: path.join(env.SB_LANZADOR_DATA_DIR, "indices-checkpoint"),
    });
    const seguimiento = crearSeguimiento({
      registro,
      checkpoints,
      cwdDe: (s) => s.directorio || proyectos[s.proyecto] || null,
    });
    const conversations = createProviderConversations({
      directory: path.join(env.SB_LANZADOR_DATA_DIR, "conversations"),
    });
    const toolCatalog = await createToolCatalogStore({
      dataDir: env.SB_LANZADOR_DATA_DIR,
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
  let fallbackToolCatalog = null;
  const getToolCatalog = async () =>
    toolCatalog ||
    (fallbackToolCatalog ??= await createToolCatalogStore({ env: {} }));
  return http.createServer(async (req, res) => {
    let datos;
    const enviar = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    try {
      const esHook = req.method === "POST" && req.url === "/eventos";
      if (
        !autorizado(req.headers.authorization, esHook ? hookHash : controlHash)
      )
        return enviar(401, { error: "No autorizado." });
      const ruta = new URL(req.url, "http://127.0.0.1");
      const accionSesion =
        /^\/sesiones\/([a-f0-9-]{36})\/(diff|pr\/propuesta|revertir|pr\/redactar|pr)$/i.exec(
          ruta.pathname,
        );
      if (req.method === "GET" && req.url === "/capacidades")
        return enviar(200, { motores: CAPACIDADES, requisitos: REQUISITOS });
      if (req.method === "GET" && accionSesion && acciones) {
        if (accionSesion[2] === "diff") {
          const numero = (v) => (v === null ? undefined : Number(v));
          const desde = numero(ruta.searchParams.get("desde"));
          const hasta = ruta.searchParams.get("hasta");
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
      if (req.method === "GET" && req.url === "/estado")
        return enviar(
          200,
          acciones
            ? await acciones.listar()
            : registro
                .leer()
                .filter((s) => !s.eliminada)
                .map(({ terminal: _terminal, ...session }) => session),
        );
      if (req.method === "GET" && req.url === "/proyectos")
        return enviar(200, Object.keys(proyectos));
      if (req.method === "GET" && req.url === "/modelos")
        return enviar(200, await catalogo.modelos());
      if (req.method === "GET" && req.url === "/uso")
        return enviar(200, await uso());
      if (req.method === "GET" && req.url === "/espacios" && espacios)
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
      const terminalRoute = /^\/sesiones\/([a-f0-9-]{36})\/terminal$/.exec(
        req.url,
      );
      const flujoRoute = /^\/sesiones\/([a-f0-9-]{36})\/stream$/.exec(req.url);
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
      if (req.method === "GET" && req.url === "/events") {
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
        /^\/sesiones\/([a-f0-9-]+)\/cancelar$/i.exec(req.url);
      if (cancelar) {
        await ejecutor.cancelar(cancelar[1]);
        return enviar(202, { ok: true });
      }
      const eliminar =
        req.method === "POST" &&
        /^\/sesiones\/([a-f0-9-]{36})\/eliminar$/i.exec(req.url);
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
        req.url.startsWith("/equipo/") &&
        accionesEquipo.includes(req.url.slice(8))
          ? req.url.slice(8)
          : null;
      if (
        req.method !== "POST" ||
        (![
          "/sesiones",
          "/eventos",
          "/espacios",
          "/herramientas/perfiles",
          "/herramientas/skills/resolver",
        ].includes(req.url) &&
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
      if (req.url === "/espacios" && espacios)
        return enviar(200, await espacios.vincular(datos));
      if (req.url === "/herramientas/perfiles") {
        const cat = await getToolCatalog();
        try {
          return enviar(200, await cat.updateProfile(datos.profileId, datos));
        } catch (err) {
          throw new ErrorLanzador(err.message, 400);
        }
      }
      if (req.url === "/herramientas/skills/resolver") {
        const cat = await getToolCatalog();
        const {
          billingAuthorized: _ignoredBilling,
          verifiedOperatorBillingGrant: _ignoredGrant,
          optInProbe = false,
          ...safeDatos
        } = datos && typeof datos === "object" ? datos : {};
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
          return enviar(200, await conversations.answer(session.id, datos));
        if (conversationRoute[2] === "messages")
          return enviar(200, await ejecutor.enviarMensaje(session.id, datos));
        if (conversationRoute[2] === "queue/cancel")
          return enviar(
            200,
            await ejecutor.cancelarCola(session.id, datos.clientMessageId),
          );
        if (conversationRoute[2] === "shutdown")
          return enviar(
            200,
            await ejecutor.cerrarConexion(
              session.id,
              typeof datos.reason === "string" && datos.reason.trim()
                ? datos.reason.trim()
                : undefined,
            ),
          );
      }
      if (accionSesion && acciones) {
        const id = accionSesion[1];
        if (accionSesion[2] === "revertir")
          return enviar(200, await acciones.revertir(id, datos.n));
        if (accionSesion[2] === "pr")
          return enviar(200, await acciones.pr(id, datos));
        if (accionSesion[2] === "pr/redactar")
          return enviar(200, await acciones.redactar(id));
        return enviar(404, { error: "Ruta no encontrada." });
      }
      if (terminalRoute) {
        if (datos.interrumpir === true && acciones) {
          const sesion = registro.leer().find((s) => s.id === terminalRoute[1]);
          if (sesion && !(await acciones.capacidades(sesion))?.interrumpir)
            throw new ErrorLanzador(
              "Esta sesión no tiene terminal en marcha para interrumpir el turno.",
            );
        }
        return enviar(200, ejecutor.entrada(terminalRoute[1], datos));
      }
      if (accionEquipo) {
        const sesion = registro
          .leer()
          .find((s) => s.id === datos.sesion && s.estado === "trabajando");
        const actor = {
          claude: "ambar",
          codex: "menta",
          agy: "lira",
          deepseek: "marina",
        }[sesion?.motor];
        if (!equipos || !sesion || !actor || datos.actor !== actor)
          return enviar(403, { error: "Sesión no activa." });
        let resultado;
        if (accionEquipo === "encargar") {
          await validarSeleccion(catalogo, datos, { coordinadora: false });
          resultado = await ejecutor.encargarHija(datos.sesion, {
            id: datos.id || null,
            motor: datos.motor,
            proyecto: datos.proyecto,
            brief: datos.brief,
            modelo: datos.modelo,
            esfuerzo: datos.esfuerzo,
            toolProfileId: datos.toolProfileId || null,
            effectiveProfile: datos.effectiveProfile || null,
            skillIds: Array.isArray(datos.skillIds) ? datos.skillIds : null,
            capabilityToken: datos.capabilityToken || null,
            billingGrantVerified: false,
            ...(datos.memberId !== undefined
              ? { memberId: datos.memberId }
              : {}),
            ...(datos.role !== undefined ? { role: datos.role } : {}),
            ...(datos.responsibility !== undefined
              ? { responsibility: datos.responsibility }
              : {}),
            ...(datos.workOrderId !== undefined
              ? { workOrderId: datos.workOrderId }
              : {}),
            ...(datos.manifest !== undefined
              ? { manifest: datos.manifest }
              : {}),
            ...(datos.manifestSha256 !== undefined
              ? { manifestSha256: datos.manifestSha256 }
              : {}),
            ...(datos.requestId !== undefined
              ? { requestId: datos.requestId }
              : {}),
            ...(datos.enqueueIfFull !== undefined
              ? { enqueueIfFull: datos.enqueueIfFull }
              : {}),
          });
        }
        if (accionEquipo === "esperar")
          resultado = await ejecutor.esperarHija(
            datos.sesion,
            datos.id,
            datos.timeout,
          );
        if (accionEquipo === "estado") resultado = equipos.estado(datos.sesion);
        if (accionEquipo === "mensaje")
          resultado = await equipos.mensaje(
            datos.sesion,
            datos.para,
            datos.texto,
          );
        if (accionEquipo === "bandeja")
          resultado = equipos.bandeja(datos.sesion);
        if (accionEquipo === "entregar") {
          const tieneCamposExtra =
            datos.ruta !== undefined ||
            datos.baseSha256 !== undefined ||
            datos.archivos !== undefined;
          resultado = tieneCamposExtra
            ? await equipos.entregar(datos.sesion, {
                titulo: datos.titulo,
                contenido: datos.contenido,
                ruta: datos.ruta,
                baseSha256: datos.baseSha256,
                archivos: datos.archivos,
              })
            : await equipos.entregar(
                datos.sesion,
                datos.titulo,
                datos.contenido,
              );
        }
        if (accionEquipo === "integrar") {
          let resolvedTarget =
            sesion.directorio || proyectos[sesion.proyecto] || null;
          if (typeof datos.targetDir === "string" && datos.targetDir.trim()) {
            const baseAllowed = resolvedTarget
              ? path.resolve(resolvedTarget)
              : null;
            const requested = path.resolve(datos.targetDir.trim());
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
          resultado = await equipos.integrar(datos.sesion, {
            entregableIds: datos.entregableIds,
            targetDir: resolvedTarget,
            resoluciones: datos.resoluciones,
          });
        }
        // Marks the sender so the room can animate a real handoff; ids only.
        if (["mensaje", "entregar"].includes(accionEquipo)) {
          try {
            const para =
              accionEquipo === "mensaje"
                ? datos.para
                : equipos.estado(datos.sesion).lider;
            if (para && para !== datos.sesion)
              await registro.actualizar(datos.sesion, {
                relevo: {
                  id: resultado.id,
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
              s.id === datos.id &&
              ["pendiente", "trabajando"].includes(s.estado),
          );
        if (!sesion) return enviar(404, { error: "Sesión no activa." });
        if (
          typeof datos.herramienta !== "string" ||
          datos.herramienta.length > 100
        )
          return enviar(400, { error: "Herramienta inválida." });
        const fase = inferirFase(datos.herramienta);
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
        ["modelo", "esfuerzo"].some(
          (k) => datos[k] !== undefined && typeof datos[k] !== "string",
        )
      )
        return enviar(400, { error: "Petición inválida." });
      if (datos.continuar) {
        const previa = acciones
          ? registro.leer().find((s) => s.id === datos.continuar)
          : null;
        if (previa && !(await acciones.capacidades(previa))?.continuar)
          throw new ErrorLanzador(
            "Este agente no permite continuar esta conversación; abre una nueva.",
          );
      }
      if (datos.continuar)
        return enviar(
          202,
          await ejecutor.continuar(datos.continuar, datos.brief),
        );
      if (
        datos.billingAuthorized === true &&
        datos.billingGrantVerified !== true
      ) {
        return enviar(403, {
          error:
            "La autorización de gasto requiere concesión verificada del operador.",
          seguro: true,
        });
      }
      await validarSeleccion(catalogo, datos, { coordinadora: true });
      return enviar(
        202,
        await ejecutor.encargar({
          ...datos,
          billingGrantVerified: datos.billingGrantVerified === true,
        }),
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
