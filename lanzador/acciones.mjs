// @ts-check
import { ErrorLanzador } from "./errores.mjs";
import { capacidadesDe } from "./motores.mjs";
import { propuestaPr } from "./pr.mjs";

const ACTIVAS = new Set(["pendiente", "trabajando"]);

/**
 * Git-backed actions of a session (revert, diff, pull request). Each one checks
 * the engine's capabilities first and answers 409 in Spanish instead of failing midway.
 */
export function crearAcciones({
  registro,
  seguimiento,
  checkpoints,
  pr,
  catalogo,
  proyectos = {},
  items,
}) {
  const cwdDe = (s) => s.directorio || proyectos[s.proyecto] || null;
  const sesionDe = (id) => {
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    if (!sesion) throw new ErrorLanzador("Sesión inexistente.", 404);
    return sesion;
  };
  async function capacidades(sesion) {
    const cwd = cwdDe(sesion);
    return capacidadesDe(sesion, cwd ? await checkpoints.info(cwd) : {});
  }
  const detener = (sesion, texto) => {
    if (ACTIVAS.has(sesion.estado)) throw new ErrorLanzador(texto);
  };

  function ultimaRespuesta(id) {
    const sub = items?.suscribir(id, () => {});
    try {
      const asistentes = (sub?.ultimos(200) ?? []).filter(
        (i) => i.tipo === "asistente" && i.texto,
      );
      return asistentes.at(-1)?.texto ?? "";
    } catch {
      return "";
    } finally {
      sub?.off();
    }
  }

  async function diff(id, desde, hasta) {
    const sesion = sesionDe(id);
    const c = await capacidades(sesion);
    if (!c?.revertirArchivos)
      throw new ErrorLanzador(
        "Los cambios solo se pueden consultar en una carpeta con repositorio git.",
      );
    return seguimiento.diff(id, desde, hasta);
  }

  async function propuesta(id) {
    const sesion = sesionDe(id);
    const c = await capacidades(sesion);
    if (!c?.crearPr)
      throw new ErrorLanzador(
        "Esta sesión no está en un repositorio con remoto en GitHub.",
      );
    const { archivos } = await seguimiento
      .diff(id)
      .catch(() => ({ archivos: [] }));
    return propuestaPr({
      sesion,
      archivos,
      ultimaRespuesta: ultimaRespuesta(id),
    });
  }

  return {
    cwdDe,
    capacidades,
    /** Sessions as the API shows them, each with its computed capabilities. */
    async listar() {
      const sesiones = registro
        .leer()
        .filter((s) => !s.eliminada)
        .map(({ terminal: _terminal, ...sesion }) => sesion);
      return Promise.all(
        sesiones.map(async (s) => ({
          ...s,
          capacidades: await capacidades(s).catch(() => null),
        })),
      );
    },
    diff,
    propuesta,
    async revertir(id, n) {
      const sesion = sesionDe(id);
      detener(sesion, "Detén el turno antes de revertir");
      const c = await capacidades(sesion);
      if (!c?.revertirArchivos)
        throw new ErrorLanzador(
          "Revertir archivos requiere una carpeta con repositorio git.",
        );
      if (!Number.isInteger(n) || n < 1)
        throw new ErrorLanzador("Punto de control inválido.", 400);
      return seguimiento.revertir(id, n);
    },
    async pr(
      id,
      { titulo, descripcion, borrador = false } = /** @type {any} */ ({}),
    ) {
      const sesion = sesionDe(id);
      detener(sesion, "Detén el turno antes de crear el PR");
      const c = await capacidades(sesion);
      if (!c?.crearPr)
        throw new ErrorLanzador(
          "Crear un PR requiere un repositorio registrado con remoto en GitHub.",
        );
      const base =
        typeof titulo === "string" && typeof descripcion === "string"
          ? null
          : await propuesta(id);
      return pr.crear({
        sesion,
        cwd: cwdDe(sesion),
        titulo: typeof titulo === "string" ? titulo : base.titulo,
        descripcion:
          typeof descripcion === "string" ? descripcion : base.descripcion,
        borrador: borrador === true,
      });
    },
    async redactar(id) {
      const sesion = sesionDe(id);
      const c = await capacidades(sesion);
      if (!c?.redactarPr)
        throw new ErrorLanzador(
          "Este agente no puede redactar el PR en esta sesión.",
        );
      const base = await propuesta(id);
      const { parche } = await seguimiento
        .diff(id)
        .catch(() => ({ parche: "" }));
      return {
        ...(await pr.redactar({
          sesion,
          cwd: cwdDe(sesion),
          propuesta: base,
          parche,
          catalogo: await catalogo.modelos().catch(() => ({})),
        })),
        fuente: "agente",
      };
    },
  };
}
