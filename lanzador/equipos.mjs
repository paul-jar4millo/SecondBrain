import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TOOL_PROFILES_BASE } from "./catalogo-herramientas.mjs";
import { ErrorLanzador } from "./errores.mjs";
import { sha256Hex as hashBytes } from "./lib/hash.mjs";

/** @import { ApprovedCandidate, DeliveryInput, IntegratedFile, IntegrationCandidate, IntegrationConflict, IntegrationOptions, IntegrationRecord, IntegrationResolution, IntegrationResult, ManifestCard, ManifestInput, MemberUpdate, Team, TeamManifest, TeamMember, TeamMetadata, TextDeliverySummary } from "./team-types.d.ts" */

const MOTORES = new Set(["claude", "codex", "agy", "deepseek"]);

/**
 * Content hash of a string, or of the JSON form of any other value.
 * @param {unknown} value
 */
const sha256Hex = (value) =>
  hashBytes(typeof value === "string" ? value : JSON.stringify(value));

/** @param {unknown} raw */
function normalizarRutaRelativa(raw) {
  if (typeof raw !== "string")
    throw new ErrorLanzador("Ruta de entregable inválida", 400);
  const unix = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !unix ||
    unix.length > 300 ||
    unix.startsWith("/") ||
    /^[a-zA-Z]:/.test(unix) ||
    unix.includes("\0")
  ) {
    throw new ErrorLanzador("Ruta de entregable inválida", 400);
  }
  const parts = unix.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git")) {
    throw new ErrorLanzador("Ruta de entregable inválida", 400);
  }
  return parts.join("/");
}

/**
 * @param {ManifestInput} manifest
 * @returns {TeamManifest | null}
 */
function normalizarManifiesto(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  if (!Array.isArray(manifest.team) || manifest.team.length === 0)
    throw new ErrorLanzador("Manifiesto de equipo inválido", 400);
  const team = manifest.team.map((card, index) => {
    const motor = card.motor ?? card.engine;
    if (!motor || !MOTORES.has(motor))
      throw new ErrorLanzador("Motor inválido en manifiesto", 400);
    return {
      id: String(card.id || `${manifest.workOrderId || "wo"}-m-${index + 1}`),
      characterId: card.characterId || null,
      motor,
      engine: motor,
      model: String(card.model || "").trim(),
      effort: card.effort ? String(card.effort).trim() : null,
      role: String(card.role || "").trim(),
      responsibility: String(card.responsibility || "").trim(),
      coordinator: Boolean(card.coordinator),
      toolProfileId: card.toolProfileId || "investigacion",
      assigned: card.assigned !== false,
    };
  });
  return {
    manifestVersion: manifest.manifestVersion ?? 1,
    workOrderId: manifest.workOrderId || null,
    teamRevision: manifest.teamRevision ?? 1,
    coordinatorId:
      manifest.coordinatorId ||
      team.find((c) => c.assigned && c.coordinator)?.id ||
      null,
    team,
    sha256: manifest.sha256 || sha256Hex({ ...manifest, team }),
  };
}

/**
 * @param {string} solicitadoId
 * @param {string} limiteId
 */
function esPerfilMasAmplio(solicitadoId, limiteId) {
  if (!solicitadoId || !limiteId || solicitadoId === limiteId) return false;
  const solicitado =
    TOOL_PROFILES_BASE[
      /** @type {keyof typeof TOOL_PROFILES_BASE} */ (solicitadoId)
    ];
  const limite =
    TOOL_PROFILES_BASE[
      /** @type {keyof typeof TOOL_PROFILES_BASE} */ (limiteId)
    ];
  if (!solicitado || !limite) return false;
  const mcpLim = new Set(limite.allowedMcps || []);
  const opLim = new Set(limite.allowedOperations || []);
  const effLim = new Set(limite.allowedEffectCategories || []);
  if ((solicitado.allowedMcps || []).some((m) => !mcpLim.has(m))) return true;
  if ((solicitado.allowedOperations || []).some((o) => !opLim.has(o)))
    return true;
  if ((solicitado.allowedEffectCategories || []).some((e) => !effLim.has(e)))
    return true;
  if (solicitado.allowBilledApi && !limite.allowBilledApi) return true;
  return false;
}

/**
 * @param {string} dir
 * @param {{ maxMiembros?: number, activo?: (sessionId: string) => boolean, onChange?: () => void }} [options]
 */
export async function abrirEquipos(
  dir,
  { maxMiembros = 4, activo = () => true, onChange = () => {} } = {},
) {
  const archivo = path.join(dir, "equipos.json");
  /** @type {Team[]} */
  let equipos;
  try {
    equipos = JSON.parse(await readFile(archivo, "utf8"));
    if (!Array.isArray(equipos))
      throw new Error("Registro de equipos inválido");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    equipos = [];
  }
  /** @type {Promise<unknown>} */
  let cola = Promise.resolve();
  /** @param {string} sesion */
  const buscar = (sesion) =>
    equipos.find((equipo) => equipo.miembros.some((m) => m.id === sesion));
  /** @param {string} sesion */
  const requerir = (sesion) => {
    const equipo = buscar(sesion);
    if (!equipo) throw new Error("Sesión sin equipo");
    return equipo;
  };
  /**
   * @param {unknown} valor
   * @param {number} max
   */
  const textoValido = (valor, max) =>
    typeof valor === "string" && valor.trim() && valor.length <= max;
  /**
   * @param {Team} equipo
   * @param {string} ruta
   */
  const latestIntegratedHash = (equipo, ruta) => {
    for (let i = (equipo.integraciones?.length || 0) - 1; i >= 0; i--) {
      const integ = equipo.integraciones?.[i];
      const hit = integ?.archivos?.find((a) => a.ruta === ruta);
      if (hit) return hit.sha256;
    }
    return null;
  };
  /**
   * @param {Team} equipo
   * @param {string} padre
   * @param {string} motor
   * @param {TeamMetadata} [meta]
   */
  function comprobar(equipo, padre, motor, meta = {}) {
    const p = equipo.miembros.find((m) => m.id === padre);
    if (!p) throw new Error("Miembro inválido");
    if (p.profundidad >= 2) throw new Error("Profundidad máxima alcanzada");
    if (!motor || !MOTORES.has(motor)) throw new Error("Motor inválido");

    // The manifest frozen with the team wins over one sent with the call.
    const mf =
      equipo.manifest ||
      (meta.manifest ? normalizarManifiesto(meta.manifest) : null);
    if (
      (meta.manifestSha256 || meta.manifest?.sha256) &&
      equipo.manifestSha256 &&
      (meta.manifestSha256 || meta.manifest?.sha256) !== equipo.manifestSha256
    ) {
      throw new ErrorLanzador(
        "Manifiesto del encargo desactualizado; recarga el equipo.",
        409,
      );
    }

    /** @type {ManifestCard | null} */
    let card = null;
    if (mf) {
      const assignedCards = mf.team.filter((c) => c.assigned !== false);
      if (meta.memberId) {
        card = assignedCards.find((c) => c.id === meta.memberId) || null;
        if (!card) {
          throw new ErrorLanzador(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
        // card was found by this id just above.
        const alreadyActive = equipo.miembros.some(
          (m) =>
            m.memberId === meta.memberId &&
            activo(m.id) &&
            (!meta.requestId || m.requestId !== meta.requestId),
        );
        if (alreadyActive) {
          throw new ErrorLanzador(
            "La integrante del manifiesto ya tiene una sesión activa.",
            409,
          );
        }
      } else {
        const candidates = assignedCards.filter(
          (c) => !c.coordinator && c.motor === motor,
        );
        const free = candidates.find(
          (c) =>
            !equipo.miembros.some((m) => m.memberId === c.id && activo(m.id)),
        );
        if (free) {
          card = free;
        } else if (candidates.length > 0) {
          if (
            equipo.miembros.filter((m) => activo(m.id)).length >=
            Math.min(maxMiembros, Math.max(1, assignedCards.length))
          ) {
            throw new Error("Límite del equipo alcanzado");
          }
          throw new ErrorLanzador(
            "Todas las tarjetas de este motor en el manifiesto ya están activas.",
            409,
          );
        } else {
          throw new ErrorLanzador(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
      }
      if (card.motor !== motor) {
        throw new ErrorLanzador(
          "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
          409,
        );
      }
      const reqModelo =
        typeof meta.modelo === "string" && meta.modelo.trim()
          ? meta.modelo.trim()
          : null;
      if (card.model && reqModelo && reqModelo !== card.model) {
        throw new ErrorLanzador(
          "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      const reqEsfuerzo =
        typeof meta.esfuerzo === "string" && meta.esfuerzo.trim()
          ? meta.esfuerzo.trim()
          : null;
      if (card.effort && reqEsfuerzo && reqEsfuerzo !== card.effort) {
        throw new ErrorLanzador(
          "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      if (
        meta.toolProfileId &&
        card.toolProfileId &&
        meta.toolProfileId !== card.toolProfileId &&
        esPerfilMasAmplio(meta.toolProfileId, card.toolProfileId)
      ) {
        throw new ErrorLanzador(
          "No puedes ampliar el perfil de herramientas respecto al manifiesto aprobado.",
          403,
        );
      }
    } else if (meta.toolProfileId && p.toolProfileId) {
      const parentIsCoord = p.toolProfileId === "coordinacion";
      const coordWorkerAllowed =
        parentIsCoord &&
        (meta.toolProfileId === "investigacion" ||
          meta.toolProfileId === "ejecucion");
      if (
        !coordWorkerAllowed &&
        esPerfilMasAmplio(meta.toolProfileId, p.toolProfileId)
      ) {
        throw new ErrorLanzador(
          "La integrante hija no puede ampliar permisos más allá del perfil autorizado.",
          403,
        );
      }
    }

    const effectiveLimit = mf
      ? Math.min(
          maxMiembros,
          Math.max(1, mf.team.filter((c) => c.assigned !== false).length),
        )
      : maxMiembros;
    if (equipo.miembros.filter((m) => activo(m.id)).length >= effectiveLimit)
      throw new Error("Límite del equipo alcanzado");

    const resolvedModelo =
      typeof meta.modelo === "string" && meta.modelo.trim()
        ? meta.modelo.trim()
        : card?.model || null;
    const resolvedEsfuerzo =
      typeof meta.esfuerzo === "string" && meta.esfuerzo.trim()
        ? meta.esfuerzo.trim()
        : card?.effort || null;
    const resolvedProfile =
      meta.toolProfileId || card?.toolProfileId || p.toolProfileId || null;

    return {
      padre: p,
      manifest: mf,
      card,
      resolved: {
        motor,
        memberId: meta.memberId || card?.id || null,
        role: meta.role || card?.role || null,
        responsibility: meta.responsibility || card?.responsibility || null,
        modelo: resolvedModelo,
        esfuerzo: resolvedEsfuerzo,
        toolProfileId: resolvedProfile,
        manifestSha256:
          mf?.sha256 || equipo.manifestSha256 || meta.manifestSha256 || null,
      },
    };
  }
  /**
   * @template Result
   * @param {() => Result} fn
   */
  function transaccion(fn) {
    const siguiente = cola.then(async () => {
      const previo = structuredClone(equipos);
      try {
        const result = fn();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = archivo + ".tmp";
        await writeFile(tmp, JSON.stringify(equipos, null, 2), { mode: 0o600 });
        await rename(tmp, archivo);
        try {
          onChange();
        } catch {
          /* observer failures do not undo persistence */
        }
        return structuredClone(result);
      } catch (error) {
        equipos = previo;
        throw error;
      }
    });
    cola = siguiente.catch(() => {});
    return siguiente;
  }
  return {
    /**
     * @param {string} lider
     * @param {TeamMetadata} [meta]
     */
    crear(lider, meta = {}) {
      return transaccion(() => {
        if (!textoValido(lider, 100) || buscar(lider))
          throw new Error("Líder inválido o ya asignado");
        const manifest = meta.manifest
          ? normalizarManifiesto(meta.manifest)
          : null;
        if (
          manifest &&
          meta.manifestSha256 &&
          manifest.sha256 !== meta.manifestSha256
        ) {
          throw new ErrorLanzador(
            "Manifiesto del encargo desactualizado; recarga el equipo.",
            409,
          );
        }
        const coordCard = manifest
          ? manifest.team.find(
              (c) =>
                c.assigned &&
                (meta.memberId ? c.id === meta.memberId : c.coordinator),
            ) || null
          : null;
        if (manifest && !coordCard) {
          throw new ErrorLanzador(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
        if (coordCard) {
          if (meta.motor && coordCard.motor !== meta.motor) {
            throw new ErrorLanzador(
              "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
              409,
            );
          }
          if (
            coordCard.model &&
            meta.modelo &&
            meta.modelo !== coordCard.model
          ) {
            throw new ErrorLanzador(
              "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
              409,
            );
          }
          if (
            coordCard.effort &&
            meta.esfuerzo &&
            meta.esfuerzo !== coordCard.effort
          ) {
            throw new ErrorLanzador(
              "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
              409,
            );
          }
        }
        /** @type {TeamMember} */
        const memberMeta = {
          id: lider,
          padreId: null,
          profundidad: 0,
          ...(meta.motor || coordCard?.motor
            ? { motor: meta.motor || coordCard?.motor }
            : {}),
          ...(meta.memberId || coordCard?.id
            ? { memberId: meta.memberId || coordCard?.id }
            : {}),
          ...(meta.role || coordCard?.role
            ? { role: meta.role || coordCard?.role }
            : {}),
          ...(meta.responsibility || coordCard?.responsibility
            ? {
                responsibility:
                  meta.responsibility || coordCard?.responsibility,
              }
            : {}),
          ...(meta.modelo || coordCard?.model
            ? { modelo: meta.modelo || coordCard?.model }
            : {}),
          ...(meta.esfuerzo || coordCard?.effort
            ? { esfuerzo: meta.esfuerzo || coordCard?.effort }
            : {}),
          ...(meta.toolProfileId || coordCard?.toolProfileId
            ? { toolProfileId: meta.toolProfileId || coordCard?.toolProfileId }
            : {}),
          ...(meta.workspacePath ? { workspacePath: meta.workspacePath } : {}),
          ...(meta.workspaceKind ? { workspaceKind: meta.workspaceKind } : {}),
        };
        /** @type {Team} */
        const equipo = {
          id: randomUUID(),
          lider,
          miembros: [memberMeta],
          mensajes: [],
          entregables: [],
          ...(meta.workOrderId ? { workOrderId: meta.workOrderId } : {}),
          ...(manifest
            ? {
                manifest,
                manifestSha256: meta.manifestSha256 || manifest.sha256,
              }
            : meta.manifestSha256
              ? { manifestSha256: meta.manifestSha256 }
              : {}),
          ...(meta.directorioIntegracion
            ? { directorioIntegracion: meta.directorioIntegracion }
            : {}),
        };
        equipos.push(equipo);
        return equipo;
      });
    },
    /**
     * @param {string} id
     * @param {string} padre
     * @param {string} hijo
     * @param {string} motor
     * @param {TeamMetadata} [meta]
     */
    agregar(id, padre, hijo, motor, meta = {}) {
      return transaccion(() => {
        const equipo = requerir(padre);
        if (equipo.id !== id || !textoValido(hijo, 100))
          throw new Error("Miembro inválido");
        if (meta.requestId) {
          const existente = equipo.miembros.find(
            (m) => m.requestId === meta.requestId && m.padreId === padre,
          );
          if (existente) return { ...existente, repetido: true };
        }
        if (buscar(hijo)) throw new Error("Miembro inválido");
        const {
          padre: p,
          manifest: mf,
          resolved,
        } = comprobar(equipo, padre, motor, meta);
        if (mf && !equipo.manifest) {
          equipo.manifest = mf;
          equipo.manifestSha256 = mf.sha256;
        }
        if (meta.workOrderId && !equipo.workOrderId) {
          equipo.workOrderId = meta.workOrderId;
        }
        if (meta.directorioIntegracion && !equipo.directorioIntegracion) {
          equipo.directorioIntegracion = meta.directorioIntegracion;
        }
        const miembro = {
          id: hijo,
          padreId: padre,
          motor,
          profundidad: p.profundidad + 1,
          ...(resolved.memberId ? { memberId: resolved.memberId } : {}),
          ...(resolved.role ? { role: resolved.role } : {}),
          ...(resolved.responsibility
            ? { responsibility: resolved.responsibility }
            : {}),
          ...(resolved.modelo ? { modelo: resolved.modelo } : {}),
          ...(resolved.esfuerzo ? { esfuerzo: resolved.esfuerzo } : {}),
          ...(resolved.toolProfileId
            ? { toolProfileId: resolved.toolProfileId }
            : {}),
          ...(meta.workOrderId || equipo.workOrderId
            ? { workOrderId: meta.workOrderId || equipo.workOrderId }
            : {}),
          ...(resolved.manifestSha256
            ? { manifestSha256: resolved.manifestSha256 }
            : {}),
          ...(meta.requestId ? { requestId: meta.requestId } : {}),
          ...(meta.workspacePath ? { workspacePath: meta.workspacePath } : {}),
          ...(meta.workspaceKind ? { workspaceKind: meta.workspaceKind } : {}),
        };
        equipo.miembros.push(miembro);
        return miembro;
      });
    },
    /**
     * @param {string} sesionId
     * @param {MemberUpdate} [cambios]
     */
    actualizarMiembro(sesionId, cambios = {}) {
      return transaccion(() => {
        const equipo = buscar(sesionId);
        if (!equipo) return null;
        const miembro = equipo.miembros.find((m) => m.id === sesionId);
        if (!miembro) return null;
        for (const campo of /** @type {const} */ ([
          "workspacePath",
          "workspaceKind",
          "modelo",
          "esfuerzo",
          "toolProfileId",
          "role",
          "responsibility",
          "estado",
        ])) {
          if (cambios[campo] !== undefined) miembro[campo] = cambios[campo];
        }
        return miembro;
      });
    },
    /**
     * @param {string} padre
     * @param {unknown} requestId
     */
    buscarPorRequestId(padre, requestId) {
      if (!requestId || typeof requestId !== "string") return null;
      const equipo = buscar(padre);
      if (!equipo) return null;
      const hit = equipo.miembros.find(
        (m) => m.requestId === requestId && m.padreId === padre,
      );
      return hit ? structuredClone(hit) : null;
    },
    /**
     * @param {string} padre
     * @param {string} motor
     * @param {TeamMetadata} [meta]
     */
    comprobar(padre, motor, meta = {}) {
      return comprobar(requerir(padre), padre, motor, meta);
    },
    /**
     * @param {string} de
     * @param {string} para
     * @param {string} texto
     */
    mensaje(de, para, texto) {
      return transaccion(() => {
        const equipo = requerir(de);
        if (
          !equipo.miembros.some((m) => m.id === para) ||
          !textoValido(texto, 10000)
        )
          throw new Error("Mensaje inválido");
        const mensaje = {
          id: randomUUID(),
          de,
          para,
          texto,
          fecha: new Date().toISOString(),
        };
        equipo.mensajes.push(mensaje);
        return mensaje;
      });
    },
    /**
     * @param {string} de
     * @param {string | DeliveryInput} tituloOInput
     * @param {string} [contenidoLegacy]
     */
    entregar(de, tituloOInput, contenidoLegacy) {
      return transaccion(() => {
        const equipo = requerir(de);
        /** @type {DeliveryInput} */
        const payload =
          tituloOInput && typeof tituloOInput === "object"
            ? tituloOInput
            : {
                titulo: /** @type {string} */ (tituloOInput),
                contenido: contenidoLegacy,
              };
        const titulo = payload.titulo;
        const contenido = payload.contenido;
        const ruta = payload.ruta ? normalizarRutaRelativa(payload.ruta) : null;
        const baseSha256 =
          typeof payload.baseSha256 === "string" && payload.baseSha256.trim()
            ? payload.baseSha256.trim()
            : null;
        let archivosNormalizados = null;
        if (Array.isArray(payload.archivos) && payload.archivos.length > 0) {
          let totalBytes = 0;
          const vistas = new Set();
          archivosNormalizados = payload.archivos.map((item) => {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item.contenido !== "string"
            )
              throw new Error("Entregable inválido");
            const r = normalizarRutaRelativa(item.ruta);
            if (vistas.has(r))
              throw new ErrorLanzador("Ruta duplicada en el entregable", 400);
            vistas.add(r);
            totalBytes += item.contenido.length;
            if (totalBytes > 250000) throw new Error("Entregable inválido");
            return {
              ruta: r,
              contenido: item.contenido,
              sha256: sha256Hex(item.contenido),
              ...(typeof item.baseSha256 === "string" && item.baseSha256.trim()
                ? { baseSha256: item.baseSha256.trim() }
                : baseSha256
                  ? { baseSha256 }
                  : {}),
            };
          });
        }
        const rawContenido =
          contenido === null || contenido === undefined ? "" : contenido;
        if (!textoValido(titulo, 200)) throw new Error("Entregable inválido");
        if (!archivosNormalizados && !textoValido(rawContenido, 100000)) {
          throw new Error("Entregable inválido");
        }
        if (typeof rawContenido !== "string" || rawContenido.length > 100000) {
          throw new Error("Entregable inválido");
        }
        const member = equipo.miembros.find((m) => m.id === de);
        const prevVersions = equipo.entregables.filter((e) =>
          ruta ? e.ruta === ruta : !e.ruta && e.titulo === titulo,
        );
        const version =
          prevVersions.reduce((max, e) => Math.max(max, e.version || 1), 0) + 1;
        const entregaSha256 = archivosNormalizados
          ? sha256Hex(
              JSON.stringify(
                archivosNormalizados.map((a) => [a.ruta, a.sha256]),
              ),
            )
          : sha256Hex(contenido || "");
        const entrega = {
          id: randomUUID(),
          de,
          ...(member?.memberId ? { memberId: member.memberId } : {}),
          ...(member?.role ? { role: member.role } : {}),
          titulo,
          contenido: rawContenido,
          ...(ruta ? { ruta } : {}),
          ...(baseSha256 ? { baseSha256 } : {}),
          sha256: entregaSha256,
          version,
          ...(archivosNormalizados ? { archivos: archivosNormalizados } : {}),
          fecha: new Date().toISOString(),
        };
        equipo.entregables.push(entrega);
        return entrega;
      });
    },
    /**
     * @param {string} sesionLider
     * @param {IntegrationOptions} [options]
     * @returns {Promise<IntegrationResult>}
     */
    integrar(
      sesionLider,
      { entregableIds = null, targetDir = null, resoluciones = [] } = {},
    ) {
      /** @type {Promise<IntegrationResult>} */
      const siguiente = cola.then(async () => {
        const previo = structuredClone(equipos);
        try {
          const equipo = requerir(sesionLider);
          if (equipo.lider !== sesionLider) {
            throw new ErrorLanzador(
              "Solo la coordinadora del equipo puede integrar entregables.",
              403,
            );
          }
          const seleccionados =
            Array.isArray(entregableIds) && entregableIds.length > 0
              ? entregableIds.map((id) => {
                  const hit = equipo.entregables.find((e) => e.id === id);
                  if (!hit)
                    throw new ErrorLanzador("Entregable inexistente", 404);
                  return hit;
                })
              : equipo.entregables;

          if (seleccionados.length === 0) {
            throw new ErrorLanzador(
              "No hay entregables para integrar en este equipo.",
              400,
            );
          }

          /** @type {Map<string, IntegrationCandidate[]>} */
          const itemsPorRuta = new Map();
          /** @type {TextDeliverySummary[]} */
          const entregablesSoloTexto = [];
          for (const e of seleccionados) {
            if (e.archivos?.length) {
              for (const f of e.archivos) {
                if (sha256Hex(f.contenido) !== f.sha256) {
                  throw new ErrorLanzador(
                    "Integridad SHA-256 inválida en entregable.",
                    409,
                  );
                }
                const list = itemsPorRuta.get(f.ruta) ?? [];
                list.push({
                  entregableId: e.id,
                  de: e.de,
                  memberId: e.memberId || null,
                  role: e.role || null,
                  ruta: f.ruta,
                  contenido: f.contenido,
                  sha256: f.sha256,
                  baseSha256: f.baseSha256 ?? e.baseSha256 ?? null,
                  version: e.version || 1,
                  fecha: e.fecha,
                });
                itemsPorRuta.set(f.ruta, list);
              }
            } else if (e.ruta) {
              if (e.sha256 && sha256Hex(e.contenido) !== e.sha256) {
                throw new ErrorLanzador(
                  "Integridad SHA-256 inválida en entregable.",
                  409,
                );
              }
              const list = itemsPorRuta.get(e.ruta) ?? [];
              list.push({
                entregableId: e.id,
                de: e.de,
                memberId: e.memberId || null,
                role: e.role || null,
                ruta: e.ruta,
                contenido: e.contenido,
                sha256: e.sha256 || sha256Hex(e.contenido),
                baseSha256: e.baseSha256 ?? null,
                version: e.version || 1,
                fecha: e.fecha,
              });
              itemsPorRuta.set(e.ruta, list);
            } else {
              entregablesSoloTexto.push({
                entregableId: e.id,
                de: e.de,
                memberId: e.memberId || null,
                titulo: e.titulo,
                sha256: e.sha256 || sha256Hex(e.contenido || ""),
                version: e.version || 1,
              });
            }
          }

          /** @type {Map<string, IntegrationResolution>} */
          const resMap = new Map();
          for (const res of Array.isArray(resoluciones) ? resoluciones : []) {
            if (res && typeof res.ruta === "string") {
              resMap.set(normalizarRutaRelativa(res.ruta), res);
            }
          }

          /** @type {IntegrationConflict[]} */
          const conflictos = [];
          /** @type {ApprovedCandidate[]} */
          const aprobados = [];
          const destinoBase = targetDir || equipo.directorioIntegracion || null;
          // Reads the file currently in the integration workspace, so edits
          // made outside the team are never overwritten silently.
          /** @param {string} ruta */
          const hashEnDisco = async (ruta) => {
            if (!destinoBase) return null;
            try {
              return sha256Hex(
                await readFile(path.resolve(destinoBase, ruta), "utf8"),
              );
            } catch (error) {
              if (error.code === "ENOENT") return null;
              throw error;
            }
          };

          // The last conflict recorded for a path, so a resolution can only
          // settle a conflict that was shown, over the destination it saw.
          /** @param {string} ruta */
          const conflictoRegistrado = (ruta) => {
            for (const registro of [...(equipo.conflictos || [])].reverse()) {
              const hit = (registro.conflictos || []).find(
                (c) => c.ruta === ruta,
              );
              if (hit) return hit;
            }
            return null;
          };

          for (const [ruta, candidatos] of itemsPorRuta.entries()) {
            const actualHash = latestIntegratedHash(equipo, ruta);
            const resolucion = resMap.get(ruta);
            if (resolucion) {
              const previo = conflictoRegistrado(ruta);
              if (!previo) {
                throw new ErrorLanzador(
                  `No hay un conflicto registrado para ${ruta}; integra primero para revisarlo.`,
                  409,
                );
              }
              const discoAhora = await hashEnDisco(ruta);
              if (discoAhora !== (previo.hashEnDisco ?? null)) {
                // The destination changed after the conflict was shown (for
                // example, a manual edit): the old resolution no longer
                // applies and nothing is overwritten.
                conflictos.push({
                  ruta,
                  motivo:
                    "El archivo de destino cambió después del conflicto registrado; revisa de nuevo antes de resolver.",
                  hashIntegradoActual: actualHash,
                  hashEnDisco: discoAhora,
                  entregas: candidatos.map((c) => ({
                    entregableId: c.entregableId,
                    de: c.de,
                    memberId: c.memberId,
                    role: c.role,
                    sha256: c.sha256,
                    baseSha256: c.baseSha256,
                    version: c.version,
                    fecha: c.fecha,
                  })),
                });
                continue;
              }
              if (typeof resolucion.contenido === "string") {
                const fuente =
                  candidatos.find(
                    (c) => c.entregableId === resolucion.entregableId,
                  ) || candidatos[candidatos.length - 1];
                aprobados.push({
                  ...fuente,
                  contenido: resolucion.contenido,
                  sha256: sha256Hex(resolucion.contenido),
                  resueltoExplicitamente: true,
                  discoEsperado: previo.hashEnDisco ?? null,
                });
                continue;
              }
              if (resolucion.entregableId) {
                const elegido = candidatos.find(
                  (c) => c.entregableId === resolucion.entregableId,
                );
                if (!elegido) {
                  throw new ErrorLanzador(
                    `La resolución para ${ruta} referencia un entregable desconocido.`,
                    400,
                  );
                }
                aprobados.push({
                  ...elegido,
                  resueltoExplicitamente: true,
                  discoEsperado: previo.hashEnDisco ?? null,
                });
                continue;
              }
            }

            // Detect concurrent edits from distinct members/versions or stale baseSha256
            const distinctHashes = new Set(candidatos.map((c) => c.sha256));
            let conflictReason = null;
            if (distinctHashes.size > 1) {
              // Concurrent edits unless strictly chained via baseSha256 (c[i].baseSha256 === c[i-1].sha256)
              let chained = true;
              for (let i = 1; i < candidatos.length; i++) {
                if (candidatos[i].baseSha256 !== candidatos[i - 1].sha256) {
                  chained = false;
                  break;
                }
              }
              if (!chained) {
                conflictReason =
                  "Entregas concurrentes sobre la misma ruta con hash base incompatible.";
              }
            }
            const ultimo = candidatos[candidatos.length - 1];
            // A chain may restart from a version already integrated; its
            // effective base is then the integrated hash, else the first base.
            const yaIntegrado =
              actualHash !== null &&
              candidatos.some((c) => c.sha256 === actualHash);
            const baseEfectiva = yaIntegrado
              ? actualHash
              : (candidatos[0].baseSha256 ?? null);
            if (
              !conflictReason &&
              actualHash !== null &&
              baseEfectiva !== actualHash
            ) {
              conflictReason =
                "El entregable parte de un hash base distinto al ya integrado en el workspace.";
            }
            const discoHash = await hashEnDisco(ruta);
            if (
              !conflictReason &&
              discoHash !== null &&
              discoHash !== ultimo.sha256 &&
              discoHash !== baseEfectiva
            ) {
              conflictReason =
                "El archivo del workspace de integración no coincide con el hash base del entregable.";
            }

            if (conflictReason) {
              conflictos.push({
                ruta,
                motivo: conflictReason,
                hashIntegradoActual: actualHash,
                hashEnDisco: discoHash,
                entregas: candidatos.map((c) => ({
                  entregableId: c.entregableId,
                  de: c.de,
                  memberId: c.memberId,
                  role: c.role,
                  sha256: c.sha256,
                  baseSha256: c.baseSha256,
                  version: c.version,
                  fecha: c.fecha,
                })),
              });
            } else {
              aprobados.push({ ...ultimo, discoEsperado: discoHash });
            }
          }

          const fecha = new Date().toISOString();
          if (conflictos.length > 0) {
            equipo.conflictos ??= [];
            equipo.conflictos.push({
              id: randomUUID(),
              fecha,
              autor: sesionLider,
              conflictos,
            });
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const tmp = archivo + ".tmp";
            await writeFile(tmp, JSON.stringify(equipos, null, 2), {
              mode: 0o600,
            });
            await rename(tmp, archivo);
            try {
              onChange();
            } catch {}
            return structuredClone({
              ok: false,
              estado: "conflicto",
              conflictos,
              integrados: [],
            });
          }

          /** @type {IntegratedFile[]} */
          const integrados = [];
          if (destinoBase && aprobados.length > 0) {
            const rootResolved = path.resolve(destinoBase);
            /** @type {Map<ApprovedCandidate, string>} */
            const destinos = new Map();
            for (const item of aprobados) {
              const dst = path.resolve(rootResolved, item.ruta);
              const rel = path.relative(rootResolved, dst);
              if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
                throw new ErrorLanzador(
                  "Ruta de integración fuera de alcance.",
                  403,
                );
              }
              destinos.set(item, dst);
            }
            // Re-read every destination right before writing: an edit made
            // while the integration was being checked is never overwritten.
            for (const item of aprobados) {
              if ((await hashEnDisco(item.ruta)) !== item.discoEsperado) {
                throw new ErrorLanzador(
                  `El archivo ${item.ruta} cambió durante la integración; vuelve a integrar para revisarlo.`,
                  409,
                );
              }
            }
            for (const item of aprobados) {
              // Every approved item got a destination in the loop above.
              const dst = /** @type {string} */ (destinos.get(item));
              await mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
              const tmpDst = `${dst}.${process.pid}.tmp`;
              await writeFile(tmpDst, item.contenido, "utf8");
              await rename(tmpDst, dst);
              integrados.push({
                ruta: item.ruta,
                sha256: item.sha256,
                baseSha256: item.baseSha256,
                version: item.version,
                fuenteEntregableId: item.entregableId,
                miembro: item.memberId || item.de,
                ...(item.resueltoExplicitamente
                  ? {
                      resueltoExplicitamente: true,
                      hashEnDiscoReemplazado: item.discoEsperado,
                    }
                  : {}),
                destino: dst,
              });
            }
          } else {
            for (const item of aprobados) {
              integrados.push({
                ruta: item.ruta,
                sha256: item.sha256,
                baseSha256: item.baseSha256,
                version: item.version,
                fuenteEntregableId: item.entregableId,
                miembro: item.memberId || item.de,
              });
            }
          }

          /** @type {IntegrationRecord} */
          const integracion = {
            id: randomUUID(),
            fecha,
            autor: sesionLider,
            ...(equipo.workOrderId ? { workOrderId: equipo.workOrderId } : {}),
            estado: "integrado",
            archivos: integrados,
            ...(entregablesSoloTexto.length
              ? { entregables: entregablesSoloTexto }
              : {}),
          };
          equipo.integraciones ??= [];
          equipo.integraciones.push(integracion);

          await mkdir(dir, { recursive: true, mode: 0o700 });
          const tmp = archivo + ".tmp";
          await writeFile(tmp, JSON.stringify(equipos, null, 2), {
            mode: 0o600,
          });
          await rename(tmp, archivo);
          try {
            onChange();
          } catch {}
          return structuredClone({
            ok: true,
            estado: "integrado",
            integracion,
            integrados,
            conflictos: [],
          });
        } catch (error) {
          equipos = previo;
          throw error;
        }
      });
      cola = siguiente.catch(() => {});
      return siguiente;
    },
    /** @param {string} id */
    bandeja(id) {
      return structuredClone(
        requerir(id).mensajes.filter((m) => m.para === id),
      );
    },
    /** @param {string} id */
    estado(id) {
      return structuredClone(requerir(id));
    },
  };
}
