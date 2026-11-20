import { LauncherError } from "./errors.mjs";
import { capabilitiesOf } from "./engines.mjs";
import { proposalPr } from "./pr.mjs";

/** @import { LauncherSession, SessionRegistry } from "./session-types.d.ts" */

const ACTIVE = new Set(["pendiente", "trabajando"]);

/**
 * Git-backed actions of a session (revert, diff, pull request). Each one checks
 * the engine's capabilities first and answers 409 in Spanish instead of failing midway.
 * @param {{
 *   registro: SessionRegistry,
 *   seguimiento: ReturnType<typeof import("./checkpoints.mjs").createTracking>,
 *   checkpoints: ReturnType<typeof import("./checkpoints.mjs").createCheckpoints>,
 *   pr: ReturnType<typeof import("./pr.mjs").createPrClient>,
 *   catalogo: ReturnType<typeof import("./models.mjs").createModelCatalog>,
 *   proyectos?: Record<string, string>,
 *   items?: ReturnType<typeof import("./items.mjs").createItems>,
 * }} options
 */
export function createActions({
  registro: registry,
  seguimiento: tracking,
  checkpoints,
  pr,
  catalogo: catalog,
  proyectos: projects = {},
  items,
}) {
  /** @param {LauncherSession} s */
  const cwdOf = (s) => s.directorio || projects[String(s.proyecto)] || null;
  /** @param {string} id */
  const sessionOf = (id) => {
    const session = registry.leer().find((s) => s.id === id && !s.eliminada);
    if (!session) throw new LauncherError("Sesión inexistente.", 404);
    return session;
  };
  /** @param {LauncherSession} session */
  async function capabilities(session) {
    const cwd = cwdOf(session);
    return capabilitiesOf(session, cwd ? await checkpoints.info(cwd) : {});
  }
  /**
   * @param {LauncherSession} session
   * @param {string} text
   */
  const stop = (session, text) => {
    if (ACTIVE.has(session.estado)) throw new LauncherError(text);
  };

  /** @param {string} id */
  function lastResponse(id) {
    const sub = items?.suscribir(id, () => {});
    try {
      const assistants = (sub?.ultimos(200) ?? []).filter(
        (i) => i.tipo === "asistente" && i.texto,
      );
      return assistants.at(-1)?.texto ?? "";
    } catch {
      return "";
    } finally {
      sub?.off();
    }
  }

  /**
   * @param {string} id
   * @param {number} [from]
   * @param {number} [until]
   */
  async function diff(id, from, until) {
    const session = sessionOf(id);
    const c = await capabilities(session);
    if (!c?.revertirArchivos)
      throw new LauncherError(
        "Los cambios solo se pueden consultar en una carpeta con repositorio git.",
      );
    return tracking.diff(id, from, until);
  }

  /** @param {string} id */
  async function proposal(id) {
    const session = sessionOf(id);
    const c = await capabilities(session);
    if (!c?.crearPr)
      throw new LauncherError(
        "Esta sesión no está en un repositorio con remoto en GitHub.",
      );
    const { archivos: files } = await tracking
      .diff(id)
      .catch(/** @returns {{ archivos: [] }} */ () => ({ archivos: [] }));
    return proposalPr({
      sesion: session,
      archivos: files,
      ultimaRespuesta: lastResponse(id),
    });
  }

  return {
    cwdDe: cwdOf,
    capacidades: capabilities,
    /** Sessions as the API shows them, each with its computed capabilities. */
    async listar() {
      const sessions = registry
        .leer()
        .filter((s) => !s.eliminada)
        .map(({ terminal: _terminal, ...session }) => session);
      return Promise.all(
        sessions.map(async (s) => ({
          ...s,
          capacidades: await capabilities(s).catch(
            /** @returns {null} */ () => null,
          ),
        })),
      );
    },
    diff,
    propuesta: proposal,
    /**
     * @param {string} id
     * @param {number} n
     */
    async revertir(id, n) {
      const session = sessionOf(id);
      stop(session, "Detén el turno antes de revertir");
      const c = await capabilities(session);
      if (!c?.revertirArchivos)
        throw new LauncherError(
          "Revertir archivos requiere una carpeta con repositorio git.",
        );
      if (!Number.isInteger(n) || n < 1)
        throw new LauncherError("Punto de control inválido.", 400);
      return tracking.revertir(id, n);
    },
    /**
     * @param {string} id
     * @param {{ titulo?: string, descripcion?: string, borrador?: boolean }} [options]
     */
    async pr(
      id,
      { titulo: title, descripcion: description, borrador: draft = false } = {},
    ) {
      const session = sessionOf(id);
      stop(session, "Detén el turno antes de crear el PR");
      const c = await capabilities(session);
      if (!c?.crearPr)
        throw new LauncherError(
          "Crear un PR requiere un repositorio registrado con remoto en GitHub.",
        );
      const base =
        typeof title === "string" && typeof description === "string"
          ? { titulo: title, descripcion: description }
          : await proposal(id);
      return pr.crear({
        sesion: session,
        // crearPr is only offered for sessions with a registered repository.
        cwd: /** @type {string} */ (cwdOf(session)),
        titulo: typeof title === "string" ? title : base.titulo,
        descripcion:
          typeof description === "string" ? description : base.descripcion,
        borrador: draft === true,
      });
    },
    /** @param {string} id */
    async redactar(id) {
      const session = sessionOf(id);
      const c = await capabilities(session);
      if (!c?.redactarPr)
        throw new LauncherError(
          "Este agente no puede redactar el PR en esta sesión.",
        );
      const base = await proposal(id);
      const { parche: patch } = await tracking
        .diff(id)
        .catch(() => ({ parche: "" }));
      return {
        ...(await pr.redactar({
          sesion: session,
          // redactarPr is only offered for sessions with a registered repository.
          cwd: /** @type {string} */ (cwdOf(session)),
          propuesta: base,
          parche: patch,
          catalogo: await catalog.modelos().catch(() => ({})),
        })),
        fuente: "agente",
      };
    },
  };
}
