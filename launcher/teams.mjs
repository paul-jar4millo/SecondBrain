import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TOOL_PROFILES_BASE } from "./tool-catalog.mjs";
import { LauncherError } from "./errors.mjs";
import { sha256Hex as hashBytes } from "./lib/hash.mjs";

/** @import { ApprovedCandidate, DeliveryInput, IntegratedFile, IntegrationCandidate, IntegrationConflict, IntegrationOptions, IntegrationRecord, IntegrationResolution, IntegrationResult, ManifestCard, ManifestInput, MemberUpdate, Team, TeamManifest, TeamMember, TeamMetadata, TextDeliverySummary } from "./team-types.d.ts" */

const ENGINES = new Set(["claude", "codex", "agy", "deepseek"]);

/**
 * Content hash of a string, or of the JSON form of any other value.
 * @param {unknown} value
 */
const sha256Hex = (value) =>
  hashBytes(typeof value === "string" ? value : JSON.stringify(value));

/** @param {unknown} raw */
function normalizeRelativePath(raw) {
  if (typeof raw !== "string")
    throw new LauncherError("Ruta de entregable inválida", 400);
  const unix = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !unix ||
    unix.length > 300 ||
    unix.startsWith("/") ||
    /^[a-zA-Z]:/.test(unix) ||
    unix.includes("\0")
  ) {
    throw new LauncherError("Ruta de entregable inválida", 400);
  }
  const parts = unix.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git")) {
    throw new LauncherError("Ruta de entregable inválida", 400);
  }
  return parts.join("/");
}

/**
 * @param {ManifestInput} manifest
 * @returns {TeamManifest | null}
 */
function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  if (!Array.isArray(manifest.team) || manifest.team.length === 0)
    throw new LauncherError("Manifiesto de equipo inválido", 400);
  const team = manifest.team.map((card, index) => {
    const motor = card.motor ?? card.engine;
    if (!motor || !ENGINES.has(motor))
      throw new LauncherError("Motor inválido en manifiesto", 400);
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
 * @param {string} requestedId
 * @param {string} limitId
 */
function isWiderProfile(requestedId, limitId) {
  if (!requestedId || !limitId || requestedId === limitId) return false;
  const requested =
    TOOL_PROFILES_BASE[
      /** @type {keyof typeof TOOL_PROFILES_BASE} */ (requestedId)
    ];
  const limit =
    TOOL_PROFILES_BASE[
      /** @type {keyof typeof TOOL_PROFILES_BASE} */ (limitId)
    ];
  if (!requested || !limit) return false;
  const mcpLim = new Set(limit.allowedMcps || []);
  const opLim = new Set(limit.allowedOperations || []);
  const effLim = new Set(limit.allowedEffectCategories || []);
  if ((requested.allowedMcps || []).some((m) => !mcpLim.has(m))) return true;
  if ((requested.allowedOperations || []).some((o) => !opLim.has(o)))
    return true;
  if ((requested.allowedEffectCategories || []).some((e) => !effLim.has(e)))
    return true;
  if (requested.allowBilledApi && !limit.allowBilledApi) return true;
  return false;
}

/**
 * @param {string} dir
 * @param {{ maxMiembros?: number, activo?: (sessionId: string) => boolean, onChange?: () => void }} [options]
 */
export async function openTeams(
  dir,
  {
    maxMiembros: maxMembers = 4,
    activo: active = () => true,
    onChange = () => {},
  } = {},
) {
  const archivo = path.join(dir, "equipos.json");
  /** @type {Team[]} */
  let teams;
  try {
    teams = JSON.parse(await readFile(archivo, "utf8"));
    if (!Array.isArray(teams)) throw new Error("Registro de equipos inválido");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    teams = [];
  }
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @param {string} session */
  const buscar = (session) =>
    teams.find((team) => team.miembros.some((m) => m.id === session));
  /** @param {string} session */
  const require = (session) => {
    const team = buscar(session);
    if (!team) throw new Error("Sesión sin equipo");
    return team;
  };
  /**
   * @param {unknown} value
   * @param {number} max
   */
  const validText = (value, max) =>
    typeof value === "string" && value.trim() && value.length <= max;
  /**
   * @param {Team} team
   * @param {string} path
   */
  const latestIntegratedHash = (team, path) => {
    for (let i = (team.integraciones?.length || 0) - 1; i >= 0; i--) {
      const integ = team.integraciones?.[i];
      const hit = integ?.archivos?.find((a) => a.ruta === path);
      if (hit) return hit.sha256;
    }
    return null;
  };
  /**
   * @param {Team} equipo
   * @param {string} parent
   * @param {string} engine
   * @param {TeamMetadata} [meta]
   */
  function check(equipo, parent, engine, meta = {}) {
    const p = equipo.miembros.find((m) => m.id === parent);
    if (!p) throw new Error("Miembro inválido");
    if (p.profundidad >= 2) throw new Error("Profundidad máxima alcanzada");
    if (!engine || !ENGINES.has(engine)) throw new Error("Motor inválido");

    // The manifest frozen with the team wins over one sent with the call.
    const mf =
      equipo.manifest ||
      (meta.manifest ? normalizeManifest(meta.manifest) : null);
    if (
      (meta.manifestSha256 || meta.manifest?.sha256) &&
      equipo.manifestSha256 &&
      (meta.manifestSha256 || meta.manifest?.sha256) !== equipo.manifestSha256
    ) {
      throw new LauncherError(
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
          throw new LauncherError(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
        // card was found by this id just above.
        const alreadyActive = equipo.miembros.some(
          (m) =>
            m.memberId === meta.memberId &&
            active(m.id) &&
            (!meta.requestId || m.requestId !== meta.requestId),
        );
        if (alreadyActive) {
          throw new LauncherError(
            "La integrante del manifiesto ya tiene una sesión activa.",
            409,
          );
        }
      } else {
        const candidates = assignedCards.filter(
          (c) => !c.coordinator && c.motor === engine,
        );
        const free = candidates.find(
          (c) =>
            !equipo.miembros.some((m) => m.memberId === c.id && active(m.id)),
        );
        if (free) {
          card = free;
        } else if (candidates.length > 0) {
          if (
            equipo.miembros.filter((m) => active(m.id)).length >=
            Math.min(maxMembers, Math.max(1, assignedCards.length))
          ) {
            throw new Error("Límite del equipo alcanzado");
          }
          throw new LauncherError(
            "Todas las tarjetas de este motor en el manifiesto ya están activas.",
            409,
          );
        } else {
          throw new LauncherError(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
      }
      if (card.motor !== engine) {
        throw new LauncherError(
          "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
          409,
        );
      }
      const reqModel =
        typeof meta.modelo === "string" && meta.modelo.trim()
          ? meta.modelo.trim()
          : null;
      if (card.model && reqModel && reqModel !== card.model) {
        throw new LauncherError(
          "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      const reqEffort =
        typeof meta.esfuerzo === "string" && meta.esfuerzo.trim()
          ? meta.esfuerzo.trim()
          : null;
      if (card.effort && reqEffort && reqEffort !== card.effort) {
        throw new LauncherError(
          "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      if (
        meta.toolProfileId &&
        card.toolProfileId &&
        meta.toolProfileId !== card.toolProfileId &&
        isWiderProfile(meta.toolProfileId, card.toolProfileId)
      ) {
        throw new LauncherError(
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
        isWiderProfile(meta.toolProfileId, p.toolProfileId)
      ) {
        throw new LauncherError(
          "La integrante hija no puede ampliar permisos más allá del perfil autorizado.",
          403,
        );
      }
    }

    const effectiveLimit = mf
      ? Math.min(
          maxMembers,
          Math.max(1, mf.team.filter((c) => c.assigned !== false).length),
        )
      : maxMembers;
    if (equipo.miembros.filter((m) => active(m.id)).length >= effectiveLimit)
      throw new Error("Límite del equipo alcanzado");

    const resolvedModel =
      typeof meta.modelo === "string" && meta.modelo.trim()
        ? meta.modelo.trim()
        : card?.model || null;
    const resolvedEffort =
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
        motor: engine,
        memberId: meta.memberId || card?.id || null,
        role: meta.role || card?.role || null,
        responsibility: meta.responsibility || card?.responsibility || null,
        modelo: resolvedModel,
        esfuerzo: resolvedEffort,
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
  function transaction(fn) {
    const next = queue.then(async () => {
      const previous = structuredClone(teams);
      try {
        const result = fn();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = archivo + ".tmp";
        await writeFile(tmp, JSON.stringify(teams, null, 2), { mode: 0o600 });
        await rename(tmp, archivo);
        try {
          onChange();
        } catch {
          /* observer failures do not undo persistence */
        }
        return structuredClone(result);
      } catch (error) {
        teams = previous;
        throw error;
      }
    });
    queue = next.catch(() => {});
    return next;
  }
  return {
    /**
     * @param {string} lead
     * @param {TeamMetadata} [meta]
     */
    crear(lead, meta = {}) {
      return transaction(() => {
        if (!validText(lead, 100) || buscar(lead))
          throw new Error("Líder inválido o ya asignado");
        const manifest = meta.manifest
          ? normalizeManifest(meta.manifest)
          : null;
        if (
          manifest &&
          meta.manifestSha256 &&
          manifest.sha256 !== meta.manifestSha256
        ) {
          throw new LauncherError(
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
          throw new LauncherError(
            "Integrante fuera del manifiesto aprobado.",
            403,
          );
        }
        if (coordCard) {
          if (meta.motor && coordCard.motor !== meta.motor) {
            throw new LauncherError(
              "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
              409,
            );
          }
          if (
            coordCard.model &&
            meta.modelo &&
            meta.modelo !== coordCard.model
          ) {
            throw new LauncherError(
              "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
              409,
            );
          }
          if (
            coordCard.effort &&
            meta.esfuerzo &&
            meta.esfuerzo !== coordCard.effort
          ) {
            throw new LauncherError(
              "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
              409,
            );
          }
        }
        /** @type {TeamMember} */
        const memberMeta = {
          id: lead,
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
          lider: lead,
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
        teams.push(equipo);
        return equipo;
      });
    },
    /**
     * @param {string} id
     * @param {string} parent
     * @param {string} child
     * @param {string} engine
     * @param {TeamMetadata} [meta]
     */
    agregar(id, parent, child, engine, meta = {}) {
      return transaction(() => {
        const team = require(parent);
        if (team.id !== id || !validText(child, 100))
          throw new Error("Miembro inválido");
        if (meta.requestId) {
          const existing = team.miembros.find(
            (m) => m.requestId === meta.requestId && m.padreId === parent,
          );
          if (existing) return { ...existing, repetido: true };
        }
        if (buscar(child)) throw new Error("Miembro inválido");
        const {
          padre: p,
          manifest: mf,
          resolved,
        } = check(team, parent, engine, meta);
        if (mf && !team.manifest) {
          team.manifest = mf;
          team.manifestSha256 = mf.sha256;
        }
        if (meta.workOrderId && !team.workOrderId) {
          team.workOrderId = meta.workOrderId;
        }
        if (meta.directorioIntegracion && !team.directorioIntegracion) {
          team.directorioIntegracion = meta.directorioIntegracion;
        }
        const member = {
          id: child,
          padreId: parent,
          motor: engine,
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
          ...(meta.workOrderId || team.workOrderId
            ? { workOrderId: meta.workOrderId || team.workOrderId }
            : {}),
          ...(resolved.manifestSha256
            ? { manifestSha256: resolved.manifestSha256 }
            : {}),
          ...(meta.requestId ? { requestId: meta.requestId } : {}),
          ...(meta.workspacePath ? { workspacePath: meta.workspacePath } : {}),
          ...(meta.workspaceKind ? { workspaceKind: meta.workspaceKind } : {}),
        };
        team.miembros.push(member);
        return member;
      });
    },
    /**
     * @param {string} sessionId
     * @param {MemberUpdate} [changes]
     */
    actualizarMiembro(sessionId, changes = {}) {
      return transaction(() => {
        const team = buscar(sessionId);
        if (!team) return null;
        const member = team.miembros.find((m) => m.id === sessionId);
        if (!member) return null;
        for (const field of /** @type {const} */ ([
          "workspacePath",
          "workspaceKind",
          "modelo",
          "esfuerzo",
          "toolProfileId",
          "role",
          "responsibility",
          "estado",
        ])) {
          if (changes[field] !== undefined) member[field] = changes[field];
        }
        return member;
      });
    },
    /**
     * @param {string} parent
     * @param {unknown} requestId
     */
    buscarPorRequestId(parent, requestId) {
      if (!requestId || typeof requestId !== "string") return null;
      const team = buscar(parent);
      if (!team) return null;
      const hit = team.miembros.find(
        (m) => m.requestId === requestId && m.padreId === parent,
      );
      return hit ? structuredClone(hit) : null;
    },
    /**
     * @param {string} parent
     * @param {string} engine
     * @param {TeamMetadata} [meta]
     */
    comprobar(parent, engine, meta = {}) {
      return check(require(parent), parent, engine, meta);
    },
    /**
     * @param {string} de
     * @param {string} para
     * @param {string} text
     */
    mensaje(de, para, text) {
      return transaction(() => {
        const team = require(de);
        if (
          !team.miembros.some((m) => m.id === para) ||
          !validText(text, 10000)
        )
          throw new Error("Mensaje inválido");
        const message = {
          id: randomUUID(),
          de,
          para,
          texto: text,
          fecha: new Date().toISOString(),
        };
        team.mensajes.push(message);
        return message;
      });
    },
    /**
     * @param {string} de
     * @param {string | DeliveryInput} titleOrInput
     * @param {string} [contentLegacy]
     */
    entregar(de, titleOrInput, contentLegacy) {
      return transaction(() => {
        const team = require(de);
        /** @type {DeliveryInput} */
        const payload =
          titleOrInput && typeof titleOrInput === "object"
            ? titleOrInput
            : {
                titulo: /** @type {string} */ (titleOrInput),
                contenido: contentLegacy,
              };
        const title = payload.titulo;
        const content = payload.contenido;
        const path = payload.ruta ? normalizeRelativePath(payload.ruta) : null;
        const baseSha256 =
          typeof payload.baseSha256 === "string" && payload.baseSha256.trim()
            ? payload.baseSha256.trim()
            : null;
        let normalizedFiles = null;
        if (Array.isArray(payload.archivos) && payload.archivos.length > 0) {
          let totalBytes = 0;
          const views = new Set();
          normalizedFiles = payload.archivos.map((item) => {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item.contenido !== "string"
            )
              throw new Error("Entregable inválido");
            const r = normalizeRelativePath(item.ruta);
            if (views.has(r))
              throw new LauncherError("Ruta duplicada en el entregable", 400);
            views.add(r);
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
        const rawContent =
          content === null || content === undefined ? "" : content;
        if (!validText(title, 200)) throw new Error("Entregable inválido");
        if (!normalizedFiles && !validText(rawContent, 100000)) {
          throw new Error("Entregable inválido");
        }
        if (typeof rawContent !== "string" || rawContent.length > 100000) {
          throw new Error("Entregable inválido");
        }
        const member = team.miembros.find((m) => m.id === de);
        const prevVersions = team.entregables.filter((e) =>
          path ? e.ruta === path : !e.ruta && e.titulo === title,
        );
        const version =
          prevVersions.reduce((max, e) => Math.max(max, e.version || 1), 0) + 1;
        const deliverySha256 = normalizedFiles
          ? sha256Hex(
              JSON.stringify(normalizedFiles.map((a) => [a.ruta, a.sha256])),
            )
          : sha256Hex(content || "");
        const delivery = {
          id: randomUUID(),
          de,
          ...(member?.memberId ? { memberId: member.memberId } : {}),
          ...(member?.role ? { role: member.role } : {}),
          titulo: title,
          contenido: rawContent,
          ...(path ? { ruta: path } : {}),
          ...(baseSha256 ? { baseSha256 } : {}),
          sha256: deliverySha256,
          version,
          ...(normalizedFiles ? { archivos: normalizedFiles } : {}),
          fecha: new Date().toISOString(),
        };
        team.entregables.push(delivery);
        return delivery;
      });
    },
    /**
     * @param {string} leadSession
     * @param {IntegrationOptions} [options]
     * @returns {Promise<IntegrationResult>}
     */
    integrar(
      leadSession,
      {
        entregableIds: deliverableIds = null,
        targetDir = null,
        resoluciones: resolutions = [],
      } = {},
    ) {
      /** @type {Promise<IntegrationResult>} */
      const next = queue.then(async () => {
        const previous = structuredClone(teams);
        try {
          const equipo = require(leadSession);
          if (equipo.lider !== leadSession) {
            throw new LauncherError(
              "Solo la coordinadora del equipo puede integrar entregables.",
              403,
            );
          }
          const selected =
            Array.isArray(deliverableIds) && deliverableIds.length > 0
              ? deliverableIds.map((id) => {
                  const hit = equipo.entregables.find((e) => e.id === id);
                  if (!hit)
                    throw new LauncherError("Entregable inexistente", 404);
                  return hit;
                })
              : equipo.entregables;

          if (selected.length === 0) {
            throw new LauncherError(
              "No hay entregables para integrar en este equipo.",
              400,
            );
          }

          /** @type {Map<string, IntegrationCandidate[]>} */
          const itemsByPath = new Map();
          /** @type {TextDeliverySummary[]} */
          const textOnlyDeliverables = [];
          for (const e of selected) {
            if (e.archivos?.length) {
              for (const f of e.archivos) {
                if (sha256Hex(f.contenido) !== f.sha256) {
                  throw new LauncherError(
                    "Integridad SHA-256 inválida en entregable.",
                    409,
                  );
                }
                const list = itemsByPath.get(f.ruta) ?? [];
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
                itemsByPath.set(f.ruta, list);
              }
            } else if (e.ruta) {
              if (e.sha256 && sha256Hex(e.contenido) !== e.sha256) {
                throw new LauncherError(
                  "Integridad SHA-256 inválida en entregable.",
                  409,
                );
              }
              const list = itemsByPath.get(e.ruta) ?? [];
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
              itemsByPath.set(e.ruta, list);
            } else {
              textOnlyDeliverables.push({
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
          for (const res of Array.isArray(resolutions) ? resolutions : []) {
            if (res && typeof res.ruta === "string") {
              resMap.set(normalizeRelativePath(res.ruta), res);
            }
          }

          /** @type {IntegrationConflict[]} */
          const conflicts = [];
          /** @type {ApprovedCandidate[]} */
          const aprobados = [];
          const targetBase = targetDir || equipo.directorioIntegracion || null;
          // Reads the file currently in the integration workspace, so edits
          // made outside the team are never overwritten silently.
          /** @param {string} ruta */
          const hashOnDisk = async (ruta) => {
            if (!targetBase) return null;
            try {
              return sha256Hex(
                await readFile(path.resolve(targetBase, ruta), "utf8"),
              );
            } catch (error) {
              if (error.code === "ENOENT") return null;
              throw error;
            }
          };

          // The last conflict recorded for a path, so a resolution can only
          // settle a conflict that was shown, over the destination it saw.
          /** @param {string} path */
          const registeredConflict = (path) => {
            for (const registry of [...(equipo.conflictos || [])].reverse()) {
              const hit = (registry.conflictos || []).find(
                (c) => c.ruta === path,
              );
              if (hit) return hit;
            }
            return null;
          };

          for (const [ruta, candidates] of itemsByPath.entries()) {
            const actualHash = latestIntegratedHash(equipo, ruta);
            const resolucion = resMap.get(ruta);
            if (resolucion) {
              const previo = registeredConflict(ruta);
              if (!previo) {
                throw new LauncherError(
                  `No hay un conflicto registrado para ${ruta}; integra primero para revisarlo.`,
                  409,
                );
              }
              const diskNow = await hashOnDisk(ruta);
              if (diskNow !== (previo.hashEnDisco ?? null)) {
                // The destination changed after the conflict was shown (for
                // example, a manual edit): the old resolution no longer
                // applies and nothing is overwritten.
                conflicts.push({
                  ruta,
                  motivo:
                    "El archivo de destino cambió después del conflicto registrado; revisa de nuevo antes de resolver.",
                  hashIntegradoActual: actualHash,
                  hashEnDisco: diskNow,
                  entregas: candidates.map((c) => ({
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
                const source =
                  candidates.find(
                    (c) => c.entregableId === resolucion.entregableId,
                  ) || candidates[candidates.length - 1];
                aprobados.push({
                  ...source,
                  contenido: resolucion.contenido,
                  sha256: sha256Hex(resolucion.contenido),
                  resueltoExplicitamente: true,
                  discoEsperado: previo.hashEnDisco ?? null,
                });
                continue;
              }
              if (resolucion.entregableId) {
                const chosen = candidates.find(
                  (c) => c.entregableId === resolucion.entregableId,
                );
                if (!chosen) {
                  throw new LauncherError(
                    `La resolución para ${ruta} referencia un entregable desconocido.`,
                    400,
                  );
                }
                aprobados.push({
                  ...chosen,
                  resueltoExplicitamente: true,
                  discoEsperado: previo.hashEnDisco ?? null,
                });
                continue;
              }
            }

            // Detect concurrent edits from distinct members/versions or stale baseSha256
            const distinctHashes = new Set(candidates.map((c) => c.sha256));
            let conflictReason = null;
            if (distinctHashes.size > 1) {
              // Concurrent edits unless strictly chained via baseSha256 (c[i].baseSha256 === c[i-1].sha256)
              let chained = true;
              for (let i = 1; i < candidates.length; i++) {
                if (candidates[i].baseSha256 !== candidates[i - 1].sha256) {
                  chained = false;
                  break;
                }
              }
              if (!chained) {
                conflictReason =
                  "Entregas concurrentes sobre la misma ruta con hash base incompatible.";
              }
            }
            const ultimo = candidates[candidates.length - 1];
            // A chain may restart from a version already integrated; its
            // effective base is then the integrated hash, else the first base.
            const alreadyIntegrated =
              actualHash !== null &&
              candidates.some((c) => c.sha256 === actualHash);
            const effectiveBase = alreadyIntegrated
              ? actualHash
              : (candidates[0].baseSha256 ?? null);
            if (
              !conflictReason &&
              actualHash !== null &&
              effectiveBase !== actualHash
            ) {
              conflictReason =
                "El entregable parte de un hash base distinto al ya integrado en el workspace.";
            }
            const diskHash = await hashOnDisk(ruta);
            if (
              !conflictReason &&
              diskHash !== null &&
              diskHash !== ultimo.sha256 &&
              diskHash !== effectiveBase
            ) {
              conflictReason =
                "El archivo del workspace de integración no coincide con el hash base del entregable.";
            }

            if (conflictReason) {
              conflicts.push({
                ruta,
                motivo: conflictReason,
                hashIntegradoActual: actualHash,
                hashEnDisco: diskHash,
                entregas: candidates.map((c) => ({
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
              aprobados.push({ ...ultimo, discoEsperado: diskHash });
            }
          }

          const date = new Date().toISOString();
          if (conflicts.length > 0) {
            equipo.conflictos ??= [];
            equipo.conflictos.push({
              id: randomUUID(),
              fecha: date,
              autor: leadSession,
              conflictos: conflicts,
            });
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const tmp = archivo + ".tmp";
            await writeFile(tmp, JSON.stringify(teams, null, 2), {
              mode: 0o600,
            });
            await rename(tmp, archivo);
            try {
              onChange();
            } catch {}
            return structuredClone({
              ok: false,
              estado: "conflicto",
              conflictos: conflicts,
              integrados: [],
            });
          }

          /** @type {IntegratedFile[]} */
          const integrados = [];
          if (targetBase && aprobados.length > 0) {
            const rootResolved = path.resolve(targetBase);
            /** @type {Map<ApprovedCandidate, string>} */
            const targets = new Map();
            for (const item of aprobados) {
              const dst = path.resolve(rootResolved, item.ruta);
              const rel = path.relative(rootResolved, dst);
              if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
                throw new LauncherError(
                  "Ruta de integración fuera de alcance.",
                  403,
                );
              }
              targets.set(item, dst);
            }
            // Re-read every destination right before writing: an edit made
            // while the integration was being checked is never overwritten.
            for (const item of aprobados) {
              if ((await hashOnDisk(item.ruta)) !== item.discoEsperado) {
                throw new LauncherError(
                  `El archivo ${item.ruta} cambió durante la integración; vuelve a integrar para revisarlo.`,
                  409,
                );
              }
            }
            for (const item of aprobados) {
              // Every approved item got a destination in the loop above.
              const dst = /** @type {string} */ (targets.get(item));
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
            fecha: date,
            autor: leadSession,
            ...(equipo.workOrderId ? { workOrderId: equipo.workOrderId } : {}),
            estado: "integrado",
            archivos: integrados,
            ...(textOnlyDeliverables.length
              ? { entregables: textOnlyDeliverables }
              : {}),
          };
          equipo.integraciones ??= [];
          equipo.integraciones.push(integracion);

          await mkdir(dir, { recursive: true, mode: 0o700 });
          const tmp = archivo + ".tmp";
          await writeFile(tmp, JSON.stringify(teams, null, 2), {
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
          teams = previous;
          throw error;
        }
      });
      queue = next.catch(() => {});
      return next;
    },
    /** @param {string} id */
    bandeja(id) {
      return structuredClone(require(id).mensajes.filter((m) => m.para === id));
    },
    /** @param {string} id */
    estado(id) {
      return structuredClone(require(id));
    },
  };
}
