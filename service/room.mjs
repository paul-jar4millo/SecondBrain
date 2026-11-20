import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
/** @import { ServerResponse } from "node:http" */

/** @typedef {{ id: string, imagen: string }} ReferencePin */
/** @typedef {{ consultas: string[], pines: ReferencePin[] }} ReferenceBank */
/** @typedef {{ tablero: string[] }} SalaSpace */
/** @typedef {"work" | "rest"} SalaOrderMode */
/** @typedef {{ id: string, mode: SalaOrderMode, instruction: string, project: string }} SalaOrder */
/**
 * @typedef {object} SalaState
 * @property {Record<string, SalaSpace>} [espacios]
 * @property {string[]} [tablero]
 * @property {{ id: string }[]} [agentes]
 * @property {Record<string, SalaOrder>} [encargos]
 */

const GENERAL = "general";
const BASE_IDS = ["ambar", "menta", "lira", "marina"];

/**
 * Banco de referencias, espacios por proyecto, agentes propias y proxy de imágenes.
 * @param {string} dataDirectory
 * @param {new (message: string, status?: number) => Error} Failure
 */
export async function createRoom(dataDirectory, Failure) {
  // Optional reference bank (links only, no image copies). Without one the
  // board starts empty; see docs/modules/service.md for its format.
  const bankFile = process.env.SB_REFERENCE_BANK;
  /** @type {ReferenceBank} */
  const banco = bankFile
    ? JSON.parse(await readFile(bankFile, "utf8"))
    : { consultas: [], pines: [] };
  const stateFile = path.join(dataDirectory, "sala.json");
  const read = await readFile(stateFile, "utf8").catch(
    /** @returns {null} */ () => null,
  );
  /** @type {SalaState} */
  const previous = read ? JSON.parse(read) : {};
  // Map, no objeto: el id del espacio viene del cliente.
  const spaces = new Map(Object.entries(previous.espacios || {}));
  // Formato anterior: un solo tablero, que pasa a la sala general.
  if (previous.tablero && !spaces.has(GENERAL))
    spaces.set(GENERAL, { tablero: previous.tablero });
  // Keep legacy custom figures on disk, but the world only has four base agents.
  let agentes = previous.agentes || [];
  const tasks = new Map(Object.entries(previous.encargos || {}));
  /** @type {Map<string, Buffer>} */
  const images = new Map();
  /** @param {string | null} id */
  const pin = (id) => banco.pines.find((p) => p.id === id);
  /** @param {unknown} [id] */
  const spaceId = (id = GENERAL) => {
    if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id))
      throw new Failure("Espacio no válido.", 400);
    return id;
  };
  /** @param {string} space */
  const boardOf = (space) => spaces.get(space)?.tablero || [];
  let writes = Promise.resolve();
  function saveState() {
    // Snapshot at mutation time; serialize temp writes and renames across requests.
    const content = JSON.stringify(
      {
        espacios: Object.fromEntries(spaces),
        agentes,
        encargos: Object.fromEntries(tasks),
      },
      null,
      2,
    );
    const writing = writes.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(stateFile + ".tmp", content);
      await rename(stateFile + ".tmp", stateFile);
    });
    writes = writing.catch(() => {});
    return writing;
  }
  function summary() {
    /** @type {Map<string, { agentes: number, tablero: number }>} */
    const account = new Map();
    /** @param {string} id */
    const de = (id) => {
      let entry = account.get(id);
      if (!entry) account.set(id, (entry = { agentes: 0, tablero: 0 }));
      return entry;
    };
    for (const [id, e] of spaces) de(id).tablero = e.tablero.length;

    return Object.fromEntries(account);
  }
  return {
    /** @param {unknown} [space] */
    leer: (space) => {
      const id = spaceId(space ?? GENERAL);
      return {
        ...banco,
        tablero: boardOf(id),
        agentes: /** @type {never[]} */ ([]),
        encargos: Object.fromEntries(tasks),
        resumen: summary(),
      };
    },
    /** @param {{ id?: unknown, guardar?: unknown, espacio?: unknown }} input */
    async guardar({ id, guardar: save, espacio: space }) {
      const where = spaceId(space);
      if (typeof id !== "string" || !pin(id))
        throw new Failure("Referencia no encontrada.", 404);
      const board = boardOf(where);
      if (Boolean(save) === board.includes(id)) return board;
      const created = save
        ? [id, ...board].slice(0, 200)
        : board.filter((x) => x !== id);
      spaces.set(where, { tablero: created });
      await saveState();
      return created;
    },
    async crearAgente() {
      throw new Failure(
        "La sala tiene cuatro agentes base. Asigna un encargo a una de ellas.",
        410,
      );
    },
    /** @param {{ id: string, mode: SalaOrderMode, instruction?: unknown, project?: unknown }} input */
    async encargar({ id, mode, instruction, project }) {
      if (!BASE_IDS.includes(id)) throw new Failure("Agente no válida.", 400);
      if (!["work", "rest"].includes(mode))
        throw new Failure("Acción no válida.", 400);
      const text = typeof instruction === "string" ? instruction.trim() : "";
      if (text.length > 2000 || (mode === "work" && !text))
        throw new Failure("Escribe un encargo de 1 a 2000 caracteres.", 400);
      const order = {
        id,
        mode,
        instruction: text,
        project: spaceId(project),
      };
      tasks.set(id, order);
      await saveState();
      return order;
    },
    /** @param {{ id: string }} input */
    async borrarAgente({ id }) {
      if (!agentes.some((a) => a.id === id))
        throw new Failure("Agente no encontrada.", 404);
      agentes = agentes.filter((a) => a.id !== id);
      await saveState();
      return { id };
    },
    /**
     * Pinterest no permite CORS; solo se piden imágenes de pines del banco.
     * @param {string | null} id
     * @param {ServerResponse} response
     */
    async imagen(id, response) {
      if (!id) throw new Failure("Referencia no encontrada.", 404);
      const reference = pin(id);
      if (!reference || !reference.imagen.startsWith("https://i.pinimg.com/"))
        throw new Failure("Referencia no encontrada.", 404);
      if (!images.has(id)) {
        const remote = await fetch(reference.imagen, {
          signal: AbortSignal.timeout(15000),
        });
        if (!remote.ok)
          throw new Failure("Pinterest no entregó la imagen.", 502);
        const chunks = [];
        let size = 0;
        for await (const chunk of remote.body ?? []) {
          size += chunk.length;
          if (size > 5 * 1024 * 1024)
            throw new Failure("La imagen remota supera 5 MB.", 502);
          chunks.push(chunk);
        }
        const oldest = images.keys().next().value;
        if (images.size >= 120 && oldest !== undefined) images.delete(oldest);
        images.set(id, Buffer.concat(chunks));
      }
      const imagen = /** @type {Buffer} */ (images.get(id));
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": imagen.length,
        "Cache-Control": "private, max-age=86400",
      });
      response.end(imagen);
    },
  };
}
