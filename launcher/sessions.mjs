import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** @import { CreateSessionInput, LauncherEngine, LauncherSession, SessionChanges, SessionObserver, SessionOrigin, SessionPruneHandler, SessionSnapshot } from "./session-types.d.ts" */

/** @typedef {Pick<LauncherSession, "terminal" | "mensajes">} SessionDetail */
/** @typedef {LauncherSession & { _detalle?: string }} SessionIndexEntry */
/** @typedef {{ silencioso?: boolean }} TransactionOptions */

const ENGINES = new Set(["claude", "codex", "agy", "deepseek"]);
const ORIGINS = new Set(["sala", "remote", "cron", "equipo", "encargo"]);
const ACTIVE = new Set(["pendiente", "trabajando"]);
const CHANGES = new Set([
  "interactiva",
  "remotoUrl",
  "conversacionId",
  "mensajes",
  "estado",
  "fase",
  "ultimaAccion",
  "resultado",
  "error",
  "relevo",
  "terminal",
  "contexto",
  "checkpoints",
  "checkpointError",
  "toolProfileId",
  "effectiveProfile",
  "skillIds",
  "skillProvenance",
  "observedSkills",
  "conexion",
  "role",
  "responsibility",
  "manifestSha256",
  "workspacePath",
  "workspaceKind",
  "enColaRecursos",
  "motivoCola",
  "enqueueOrder",
]);
const STATES = new Set([
  "pendiente",
  "trabajando",
  "terminada",
  "error",
  "cancelada",
  "interrumpida",
]);

/**
 * @template Value
 * @param {Value} value
 */
function congelar(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) congelar(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {string} file
 * @param {{ retencionDias?: number, onPrune?: SessionPruneHandler | null }} [options]
 */
export async function openSessionRegistry(
  file,
  { retencionDias: retentionDays = 90, onPrune = null } = {},
) {
  /** @type {SessionIndexEntry[]} */
  let sesiones;
  try {
    const indice = /** @type {unknown} */ (
      JSON.parse(await readFile(file, "utf8"))
    );
    if (!Array.isArray(indice))
      throw new Error("Registro de sesiones inválido");
    sesiones = /** @type {SessionIndexEntry[]} */ (indice);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sesiones = [];
  }
  const detalles = file + ".d";
  /** @type {Map<string, string>} */
  const references = new Map();
  /** @type {Map<string, SessionDetail>} */
  const known = new Map();
  let migrate = false;
  for (const sesion of sesiones) {
    // A legacy creation date does not tell us when the last turn finished.
    // Give undated finished sessions a complete retention window on migration.
    if (
      !ACTIVE.has(sesion.estado) &&
      !sesion.interactiva &&
      !Number.isFinite(Date.parse(sesion.finalizada ?? ""))
    ) {
      sesion.finalizada =
        sesion.actualizada !== undefined &&
        Number.isFinite(Date.parse(sesion.actualizada))
          ? sesion.actualizada
          : new Date().toISOString();
      migrate = true;
    }
    if (
      sesion.eliminada &&
      !Number.isFinite(Date.parse(sesion.eliminadaEn ?? ""))
    ) {
      sesion.eliminadaEn = sesion.finalizada;
      migrate = true;
    }
    if (sesion._detalle) {
      if (!/^[a-f0-9]{64}\.json$/.test(sesion._detalle))
        throw new Error("Detalle de sesión inválido");
      const detail = /** @type {SessionDetail} */ (
        JSON.parse(await readFile(path.join(detalles, sesion._detalle), "utf8"))
      );
      references.set(sesion.id, sesion._detalle);
      Object.assign(sesion, detail);
      known.set(sesion.id, {
        terminal: sesion.terminal,
        mensajes: sesion.mensajes,
      });
      delete sesion._detalle;
    } else if (sesion.terminal !== undefined || sesion.mensajes !== undefined)
      migrate = true;
  }
  /** @type {Set<SessionObserver>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {SessionSnapshot | undefined} */
  let snapshot;
  const read = () => (snapshot ??= congelar(structuredClone(sesiones)));
  let pruneHandler = onPrune;
  /** @type {LauncherSession[]} */
  const pendingPruned = [];
  function prune() {
    const cutoff = Date.now() - retentionDays * 86400000;
    const kept = [];
    const pruned = [];
    for (const s of sesiones) {
      const keep =
        ACTIVE.has(s.estado) ||
        s.interactiva ||
        !(Date.parse(s.eliminadaEn || s.finalizada || s.creada) < cutoff);
      if (keep) kept.push(s);
      else pruned.push(s);
    }
    sesiones = kept;
    if (pruned.length) pendingPruned.push(...pruned);
    return pruned.length > 0;
  }
  async function drainPruned() {
    if (!pruneHandler || pendingPruned.length === 0) return;
    const batch = pendingPruned.splice(0, pendingPruned.length);
    for (const s of batch) {
      await Promise.resolve(pruneHandler(structuredClone(s))).catch(() => {});
    }
  }
  async function save() {
    await mkdir(path.dirname(file), { recursive: true });
    prune();
    const indice = [];
    /** @type {Map<string, string>} */
    const next = new Map();
    for (const s of sesiones) {
      const { terminal, mensajes: messages, ...meta } = s;
      const previous = known.get(s.id);
      if (terminal !== undefined || messages !== undefined) {
        let reference = references.get(s.id);
        if (
          !reference ||
          previous?.terminal !== terminal ||
          previous?.mensajes !== messages
        ) {
          const contenido = JSON.stringify({ terminal, mensajes: messages });
          reference =
            createHash("sha256")
              .update(String(s.id))
              .update("\0")
              .update(contenido)
              .digest("hex") + ".json";
          await mkdir(detalles, { recursive: true, mode: 0o700 });
          // Immutable content-addressed details are committed by the index rename.
          const target = path.join(detalles, reference);
          await writeFile(target + ".tmp", contenido, { mode: 0o600 });
          await rename(target + ".tmp", target);
        }
        next.set(s.id, reference);
        meta._detalle = reference;
      }
      indice.push(meta);
    }
    const temporary = file + ".tmp";
    await writeFile(temporary, JSON.stringify(indice), {
      mode: 0o600,
    });
    await rename(temporary, file);
    const current = new Set(next.values());
    const stale = [...references.values()].filter((name) => !current.has(name));
    references.clear();
    known.clear();
    for (const s of sesiones) {
      const referencia = next.get(s.id);
      if (referencia !== undefined) references.set(s.id, referencia);
      known.set(s.id, { terminal: s.terminal, mensajes: s.mensajes });
    }
    snapshot = undefined;
    for (const nombre of stale)
      await rm(path.join(detalles, nombre), { force: true }).catch(() => {});
    await drainPruned();
  }
  const podadas = prune();
  const interrupted = sesiones.filter(
    (s) => ACTIVE.has(s.estado) || s.interactiva,
  );
  if (interrupted.length || migrate || podadas) {
    for (const s of interrupted) {
      s.estado = "interrumpida";
      s.interactiva = false;
      s.finalizada = new Date().toISOString();
    }
    await save();
  }
  // Reclaim obsolete revisions after the durable index has been recovered.
  const vigentes = new Set(references.values());
  for (const nombre of await readdir(detalles).catch(
    /** @returns {string[]} */ (error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    },
  )) {
    if (/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(nombre) && !vigentes.has(nombre))
      await rm(path.join(detalles, nombre), { force: true });
  }
  /**
   * @template Result
   * @param {() => Result} fn
   * @param {TransactionOptions} [options]
   */
  function transaction(fn, { silencioso: silent = false } = {}) {
    const next = queue.then(async () => {
      // Mutations replace fields, never edit nested messages or terminal data.
      const previous = sesiones.map((s) => ({ ...s }));
      let result;
      try {
        result = fn();
        await save();
      } catch (error) {
        sesiones = previous;
        snapshot = undefined;
        throw error;
      }
      if (silent) return structuredClone(result);
      for (const listener of listeners) {
        try {
          listener(read());
        } catch {
          /* observers do not affect persistence */
        }
      }
      return structuredClone(result);
    });
    queue = next.catch(() => {});
    return next;
  }
  return {
    leer: read,
    notificar() {
      for (const listener of listeners) {
        try {
          listener(read());
        } catch {}
      }
    },
    /** @param {SessionObserver} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** @param {SessionPruneHandler | null} fn */
    setOnPrune(fn) {
      pruneHandler = typeof fn === "function" ? fn : null;
      void drainPruned();
    },
    /** @param {CreateSessionInput} input */
    crear({
      id = null,
      motor: engine,
      origen: origin,
      equipoId: teamId = null,
      padreId: parentId = null,
      proyecto: project = null,
      encargo: task = null,
      modelo: model = null,
      esfuerzo: effort = null,
      espacioId: spaceId = null,
      harness = false,
      structured = false,
      directorio: directory = null,
      workOrderId = null,
      memberId = null,
      role = null,
      responsibility = null,
      manifestSha256 = null,
      toolProfileId = null,
      effectiveProfile = null,
      skillIds = null,
      billingGrantVerified = false,
      workspacePath = null,
      workspaceKind = null,
      enColaRecursos: queuedForResources = false,
      motivoCola: queueReason = null,
      enqueueOrder = null,
    }) {
      return transaction(() => {
        if (!ENGINES.has(engine) || !ORIGINS.has(origin))
          throw new Error("Motor u origen inválido");
        let sessionId;
        if (id != null) {
          const requestedId = String(id).trim();
          if (
            !/^[a-zA-Z0-9_-]{8,128}$/.test(requestedId) ||
            sesiones.some((s) => s.id === requestedId)
          ) {
            throw new Error("ID de sesión inválido o duplicado");
          }
          sessionId = requestedId;
        } else {
          sessionId = randomUUID();
        }
        const used = new Set(
          sesiones
            .filter((s) => s.motor === engine && ACTIVE.has(s.estado))
            .map((s) => s.copia),
        );
        let copy = 0;
        while (used.has(copy)) copy++;
        const cleanSkillIds = Array.isArray(skillIds)
          ? [
              ...new Set(
                skillIds.map((s) => String(s || "").trim()).filter(Boolean),
              ),
            ]
          : [];
        /** @type {LauncherSession} */
        const session = {
          id: sessionId,
          motor: /** @type {LauncherEngine} */ (engine),
          origen: /** @type {SessionOrigin} */ (origin),
          equipoId: teamId,
          padreId: parentId,
          proyecto: project,
          espacioId: spaceId,
          harness,
          ...(structured ? { structured: true } : {}),
          ...(workOrderId ? { workOrderId } : {}),
          ...(memberId ? { memberId } : {}),
          ...(role ? { role } : {}),
          ...(responsibility ? { responsibility } : {}),
          ...(manifestSha256 ? { manifestSha256 } : {}),
          ...(toolProfileId ? { toolProfileId } : {}),
          ...(effectiveProfile && typeof effectiveProfile === "object"
            ? { effectiveProfile }
            : {}),
          ...(cleanSkillIds.length > 0 ? { skillIds: cleanSkillIds } : {}),
          ...(billingGrantVerified === true ? { billingAuthorized: true } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceKind ? { workspaceKind } : {}),
          ...(queuedForResources ? { enColaRecursos: true } : {}),
          ...(queueReason ? { motivoCola: queueReason } : {}),
          ...(enqueueOrder !== null && enqueueOrder !== undefined
            ? { enqueueOrder }
            : {}),
          directorio: directory,
          copia: copy,
          encargo: typeof task === "string" ? task.slice(0, 4000) : null,
          creada: new Date().toISOString(),
          modelo: typeof model === "string" ? model : null,
          esfuerzo: typeof effort === "string" ? effort : null,
          estado: "pendiente",
          fase: null,
          ultimaAccion: null,
        };
        sesiones.push(session);
        return session;
      });
    },
    /**
     * @param {string} id
     * @param {string} teamId
     * @returns {Promise<LauncherSession>}
     */
    vincularEquipo(id, teamId) {
      return transaction(() => {
        const session = sesiones.find((s) => s.id === id);
        if (!session || (session.equipoId && session.equipoId !== teamId))
          throw new Error("Sesión no vinculable");
        session.equipoId = teamId;
        return session;
      });
    },
    /**
     * Hides a finished conversation for good. A tombstone keeps its provider id
     * so the transcript observer never brings it back as a new session.
     * @param {string} id
     */
    eliminar(id) {
      return transaction(() => {
        const session = sesiones.find((s) => s.id === id && !s.eliminada);
        if (!session) throw new Error("Sesión inexistente");
        if (ACTIVE.has(session.estado) || session.interactiva)
          throw new Error("Detén la sesión antes de eliminarla");
        for (const field of /** @type {const} */ ([
          "mensajes",
          "terminal",
          "resultado",
          "error",
          "checkpoints",
          "checkpointError",
        ]))
          delete session[field];
        session.encargo = null;
        session.eliminada = true;
        session.eliminadaEn = new Date().toISOString();
        return { id };
      });
    },
    /**
     * @param {string} id
     * @param {SessionChanges} changes
     * @param {TransactionOptions} [options]
     * @returns {Promise<LauncherSession>}
     */
    actualizar(id, changes, options) {
      return transaction(() => {
        const session = sesiones.find((s) => s.id === id);
        if (!session) throw new Error("Sesión inexistente");
        // Observers keep polling provider transcripts; a deleted chat stays empty.
        if (session.eliminada) return session;
        if (Object.keys(changes).some((k) => !CHANGES.has(k)))
          throw new Error("Campo no modificable");
        if (changes.estado && !STATES.has(changes.estado))
          throw new Error("Estado inválido");
        Object.assign(session, changes);
        if (changes.estado && !ACTIVE.has(changes.estado))
          session.finalizada = new Date().toISOString();
        return session;
      }, options);
    },
  };
}
