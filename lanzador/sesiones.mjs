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

const MOTORES = new Set(["claude", "codex", "agy", "deepseek"]);
const ORIGENES = new Set(["sala", "remote", "cron", "equipo", "encargo"]);
const ACTIVOS = new Set(["pendiente", "trabajando"]);
const CAMBIOS = new Set([
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
const ESTADOS = new Set([
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
 * @param {string} archivo
 * @param {{ retencionDias?: number, onPrune?: SessionPruneHandler | null }} [options]
 */
export async function abrirRegistro(
  archivo,
  { retencionDias = 90, onPrune = null } = {},
) {
  /** @type {SessionIndexEntry[]} */
  let sesiones;
  try {
    const indice = /** @type {unknown} */ (
      JSON.parse(await readFile(archivo, "utf8"))
    );
    if (!Array.isArray(indice))
      throw new Error("Registro de sesiones inválido");
    sesiones = /** @type {SessionIndexEntry[]} */ (indice);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sesiones = [];
  }
  const detalles = archivo + ".d";
  /** @type {Map<string, string>} */
  const referencias = new Map();
  /** @type {Map<string, SessionDetail>} */
  const conocidos = new Map();
  let migrar = false;
  for (const sesion of sesiones) {
    // A legacy creation date does not tell us when the last turn finished.
    // Give undated finished sessions a complete retention window on migration.
    if (
      !ACTIVOS.has(sesion.estado) &&
      !sesion.interactiva &&
      !Number.isFinite(Date.parse(sesion.finalizada))
    ) {
      sesion.finalizada = Number.isFinite(Date.parse(sesion.actualizada))
        ? sesion.actualizada
        : new Date().toISOString();
      migrar = true;
    }
    if (sesion.eliminada && !Number.isFinite(Date.parse(sesion.eliminadaEn))) {
      sesion.eliminadaEn = sesion.finalizada;
      migrar = true;
    }
    if (sesion._detalle) {
      if (!/^[a-f0-9]{64}\.json$/.test(sesion._detalle))
        throw new Error("Detalle de sesión inválido");
      const detalle = /** @type {SessionDetail} */ (
        JSON.parse(await readFile(path.join(detalles, sesion._detalle), "utf8"))
      );
      referencias.set(sesion.id, sesion._detalle);
      Object.assign(sesion, detalle);
      conocidos.set(sesion.id, {
        terminal: sesion.terminal,
        mensajes: sesion.mensajes,
      });
      delete sesion._detalle;
    } else if (sesion.terminal !== undefined || sesion.mensajes !== undefined)
      migrar = true;
  }
  /** @type {Set<SessionObserver>} */
  const oyentes = new Set();
  /** @type {Promise<unknown>} */
  let cola = Promise.resolve();
  /** @type {SessionSnapshot | undefined} */
  let instantanea;
  const leer = () => (instantanea ??= congelar(structuredClone(sesiones)));
  let pruneHandler = onPrune;
  /** @type {LauncherSession[]} */
  const pendingPruned = [];
  function podar() {
    const corte = Date.now() - retencionDias * 86400000;
    const conservadas = [];
    const podadas = [];
    for (const s of sesiones) {
      const conservar =
        ACTIVOS.has(s.estado) ||
        s.interactiva ||
        !(Date.parse(s.eliminadaEn || s.finalizada || s.creada) < corte);
      if (conservar) conservadas.push(s);
      else podadas.push(s);
    }
    sesiones = conservadas;
    if (podadas.length) pendingPruned.push(...podadas);
    return podadas.length > 0;
  }
  async function drenarPodadas() {
    if (!pruneHandler || pendingPruned.length === 0) return;
    const lote = pendingPruned.splice(0, pendingPruned.length);
    for (const s of lote) {
      await Promise.resolve(pruneHandler(structuredClone(s))).catch(() => {});
    }
  }
  async function guardar() {
    await mkdir(path.dirname(archivo), { recursive: true });
    podar();
    const indice = [];
    /** @type {Map<string, string>} */
    const siguientes = new Map();
    for (const s of sesiones) {
      const { terminal, mensajes, ...meta } = s;
      const previo = conocidos.get(s.id);
      if (terminal !== undefined || mensajes !== undefined) {
        let referencia = referencias.get(s.id);
        if (
          !referencia ||
          previo?.terminal !== terminal ||
          previo?.mensajes !== mensajes
        ) {
          const contenido = JSON.stringify({ terminal, mensajes });
          referencia =
            createHash("sha256")
              .update(String(s.id))
              .update("\0")
              .update(contenido)
              .digest("hex") + ".json";
          await mkdir(detalles, { recursive: true, mode: 0o700 });
          // Immutable content-addressed details are committed by the index rename.
          const destino = path.join(detalles, referencia);
          await writeFile(destino + ".tmp", contenido, { mode: 0o600 });
          await rename(destino + ".tmp", destino);
        }
        siguientes.set(s.id, referencia);
        meta._detalle = referencia;
      }
      indice.push(meta);
    }
    const temporal = archivo + ".tmp";
    await writeFile(temporal, JSON.stringify(indice), {
      mode: 0o600,
    });
    await rename(temporal, archivo);
    const vigentes = new Set(siguientes.values());
    const obsoletas = [...referencias.values()].filter(
      (nombre) => !vigentes.has(nombre),
    );
    referencias.clear();
    conocidos.clear();
    for (const s of sesiones) {
      if (siguientes.has(s.id)) referencias.set(s.id, siguientes.get(s.id));
      conocidos.set(s.id, { terminal: s.terminal, mensajes: s.mensajes });
    }
    instantanea = undefined;
    for (const nombre of obsoletas)
      await rm(path.join(detalles, nombre), { force: true }).catch(() => {});
    await drenarPodadas();
  }
  const podadas = podar();
  const interrumpidas = sesiones.filter(
    (s) => ACTIVOS.has(s.estado) || s.interactiva,
  );
  if (interrumpidas.length || migrar || podadas) {
    for (const s of interrumpidas) {
      s.estado = "interrumpida";
      s.interactiva = false;
      s.finalizada = new Date().toISOString();
    }
    await guardar();
  }
  // Reclaim obsolete revisions after the durable index has been recovered.
  const vigentes = new Set(referencias.values());
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
  function transaccion(fn, { silencioso = false } = {}) {
    const siguiente = cola.then(async () => {
      // Mutations replace fields, never edit nested messages or terminal data.
      const anterior = sesiones.map((s) => ({ ...s }));
      let resultado;
      try {
        resultado = fn();
        await guardar();
      } catch (error) {
        sesiones = anterior;
        instantanea = undefined;
        throw error;
      }
      if (silencioso) return structuredClone(resultado);
      for (const oyente of oyentes) {
        try {
          oyente(leer());
        } catch {
          /* observers do not affect persistence */
        }
      }
      return structuredClone(resultado);
    });
    cola = siguiente.catch(() => {});
    return siguiente;
  }
  return {
    leer,
    notificar() {
      for (const oyente of oyentes) {
        try {
          oyente(leer());
        } catch {}
      }
    },
    /** @param {SessionObserver} fn */
    subscribe(fn) {
      oyentes.add(fn);
      return () => oyentes.delete(fn);
    },
    /** @param {SessionPruneHandler | null} fn */
    setOnPrune(fn) {
      pruneHandler = typeof fn === "function" ? fn : null;
      void drenarPodadas();
    },
    /** @param {CreateSessionInput} input */
    crear({
      id = null,
      motor,
      origen,
      equipoId = null,
      padreId = null,
      proyecto = null,
      encargo = null,
      modelo = null,
      esfuerzo = null,
      espacioId = null,
      harness = false,
      structured = false,
      directorio = null,
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
      enColaRecursos = false,
      motivoCola = null,
      enqueueOrder = null,
    }) {
      return transaccion(() => {
        if (!MOTORES.has(motor) || !ORIGENES.has(origen))
          throw new Error("Motor u origen inválido");
        let sesionId;
        if (id != null) {
          const requestedId = String(id).trim();
          if (
            !/^[a-zA-Z0-9_-]{8,128}$/.test(requestedId) ||
            sesiones.some((s) => s.id === requestedId)
          ) {
            throw new Error("ID de sesión inválido o duplicado");
          }
          sesionId = requestedId;
        } else {
          sesionId = randomUUID();
        }
        const usadas = new Set(
          sesiones
            .filter((s) => s.motor === motor && ACTIVOS.has(s.estado))
            .map((s) => s.copia),
        );
        let copia = 0;
        while (usadas.has(copia)) copia++;
        const cleanSkillIds = Array.isArray(skillIds)
          ? [
              ...new Set(
                skillIds.map((s) => String(s || "").trim()).filter(Boolean),
              ),
            ]
          : [];
        /** @type {LauncherSession} */
        const sesion = {
          id: sesionId,
          motor: /** @type {LauncherEngine} */ (motor),
          origen: /** @type {SessionOrigin} */ (origen),
          equipoId,
          padreId,
          proyecto,
          espacioId,
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
          ...(enColaRecursos ? { enColaRecursos: true } : {}),
          ...(motivoCola ? { motivoCola } : {}),
          ...(enqueueOrder !== null && enqueueOrder !== undefined
            ? { enqueueOrder }
            : {}),
          directorio,
          copia,
          encargo: typeof encargo === "string" ? encargo.slice(0, 4000) : null,
          creada: new Date().toISOString(),
          modelo: typeof modelo === "string" ? modelo : null,
          esfuerzo: typeof esfuerzo === "string" ? esfuerzo : null,
          estado: "pendiente",
          fase: null,
          ultimaAccion: null,
        };
        sesiones.push(sesion);
        return sesion;
      });
    },
    /**
     * @param {string} id
     * @param {string} equipoId
     * @returns {Promise<LauncherSession>}
     */
    vincularEquipo(id, equipoId) {
      return transaccion(() => {
        const sesion = sesiones.find((s) => s.id === id);
        if (!sesion || (sesion.equipoId && sesion.equipoId !== equipoId))
          throw new Error("Sesión no vinculable");
        sesion.equipoId = equipoId;
        return sesion;
      });
    },
    /**
     * Hides a finished conversation for good. A tombstone keeps its provider id
     * so the transcript observer never brings it back as a new session.
     * @param {string} id
     */
    eliminar(id) {
      return transaccion(() => {
        const sesion = sesiones.find((s) => s.id === id && !s.eliminada);
        if (!sesion) throw new Error("Sesión inexistente");
        if (ACTIVOS.has(sesion.estado) || sesion.interactiva)
          throw new Error("Detén la sesión antes de eliminarla");
        for (const campo of /** @type {const} */ ([
          "mensajes",
          "terminal",
          "resultado",
          "error",
          "checkpoints",
          "checkpointError",
        ]))
          delete sesion[campo];
        sesion.encargo = null;
        sesion.eliminada = true;
        sesion.eliminadaEn = new Date().toISOString();
        return { id };
      });
    },
    /**
     * @param {string} id
     * @param {SessionChanges} cambios
     * @param {TransactionOptions} [opciones]
     * @returns {Promise<LauncherSession>}
     */
    actualizar(id, cambios, opciones) {
      return transaccion(() => {
        const sesion = sesiones.find((s) => s.id === id);
        if (!sesion) throw new Error("Sesión inexistente");
        // Observers keep polling provider transcripts; a deleted chat stays empty.
        if (sesion.eliminada) return sesion;
        if (Object.keys(cambios).some((k) => !CAMBIOS.has(k)))
          throw new Error("Campo no modificable");
        if (cambios.estado && !ESTADOS.has(cambios.estado))
          throw new Error("Estado inválido");
        Object.assign(sesion, cambios);
        if (cambios.estado && !ACTIVOS.has(cambios.estado))
          sesion.finalizada = new Date().toISOString();
        return sesion;
      }, opciones);
    },
  };
}
