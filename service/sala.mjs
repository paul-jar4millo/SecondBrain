import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const GENERAL = "general";
const BASE_IDS = ["ambar", "menta", "lira", "marina"];

/** Banco de referencias, espacios por proyecto, agentes propias y proxy de imágenes. */
export async function createSala(dataDirectory, Failure) {
  // Optional reference bank (links only, no image copies). Without one the
  // board starts empty; see docs/modules/service.md for its format.
  const bancoFile = process.env.SB_REFERENCE_BANK;
  const banco = bancoFile
    ? JSON.parse(await readFile(bancoFile, "utf8"))
    : { consultas: [], pines: [] };
  const estadoFile = path.join(dataDirectory, "sala.json");
  const leido = await readFile(estadoFile, "utf8").catch(() => null);
  const previo = leido ? JSON.parse(leido) : {};
  // Map, no objeto: el id del espacio viene del cliente.
  const espacios = new Map(Object.entries(previo.espacios || {}));
  // Formato anterior: un solo tablero, que pasa a la sala general.
  if (previo.tablero && !espacios.has(GENERAL))
    espacios.set(GENERAL, { tablero: previo.tablero });
  // Keep legacy custom figures on disk, but the world only has four base agents.
  let agentes = previo.agentes || [];
  const encargos = new Map(Object.entries(previo.encargos || {}));
  const imagenes = new Map();
  const pin = (id) => banco.pines.find((p) => p.id === id);
  const idEspacio = (id = GENERAL) => {
    if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id))
      throw new Failure("Espacio no válido.", 400);
    return id;
  };
  const tableroDe = (espacio) => espacios.get(espacio)?.tablero || [];
  let writes = Promise.resolve();
  function guardarEstado() {
    // Snapshot at mutation time; serialize temp writes and renames across requests.
    const content = JSON.stringify(
      {
        espacios: Object.fromEntries(espacios),
        agentes,
        encargos: Object.fromEntries(encargos),
      },
      null,
      2,
    );
    const writing = writes.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(estadoFile + ".tmp", content);
      await rename(estadoFile + ".tmp", estadoFile);
    });
    writes = writing.catch(() => {});
    return writing;
  }
  function resumen() {
    const cuenta = new Map();
    const de = (id) =>
      cuenta.get(id) || cuenta.set(id, { agentes: 0, tablero: 0 }).get(id);
    for (const [id, e] of espacios) de(id).tablero = e.tablero.length;

    return Object.fromEntries(cuenta);
  }
  return {
    leer: (espacio) => {
      const id = idEspacio(espacio ?? GENERAL);
      return {
        ...banco,
        tablero: tableroDe(id),
        agentes: [],
        encargos: Object.fromEntries(encargos),
        resumen: resumen(),
      };
    },
    async guardar({ id, guardar, espacio }) {
      const donde = idEspacio(espacio);
      if (typeof id !== "string" || !pin(id))
        throw new Failure("Referencia no encontrada.", 404);
      const tablero = tableroDe(donde);
      if (Boolean(guardar) === tablero.includes(id)) return tablero;
      const nuevo = guardar
        ? [id, ...tablero].slice(0, 200)
        : tablero.filter((x) => x !== id);
      espacios.set(donde, { tablero: nuevo });
      await guardarEstado();
      return nuevo;
    },
    async crearAgente() {
      throw new Failure(
        "La sala tiene cuatro agentes base. Asigna un encargo a una de ellas.",
        410,
      );
    },
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
        project: idEspacio(project),
      };
      encargos.set(id, order);
      await guardarEstado();
      return order;
    },
    async borrarAgente({ id }) {
      if (!agentes.some((a) => a.id === id))
        throw new Failure("Agente no encontrada.", 404);
      agentes = agentes.filter((a) => a.id !== id);
      await guardarEstado();
      return { id };
    },
    // Pinterest no permite CORS; solo se piden imágenes de pines del banco.
    async imagen(id, response) {
      const referencia = pin(id);
      if (!referencia || !referencia.imagen.startsWith("https://i.pinimg.com/"))
        throw new Failure("Referencia no encontrada.", 404);
      if (!imagenes.has(id)) {
        const remota = await fetch(referencia.imagen, {
          signal: AbortSignal.timeout(15000),
        });
        if (!remota.ok)
          throw new Failure("Pinterest no entregó la imagen.", 502);
        const chunks = [];
        let size = 0;
        for await (const chunk of remota.body) {
          size += chunk.length;
          if (size > 5 * 1024 * 1024)
            throw new Failure("La imagen remota supera 5 MB.", 502);
          chunks.push(chunk);
        }
        if (imagenes.size >= 120) imagenes.delete(imagenes.keys().next().value);
        imagenes.set(id, Buffer.concat(chunks));
      }
      const imagen = imagenes.get(id);
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": imagen.length,
        "Cache-Control": "private, max-age=86400",
      });
      response.end(imagen);
    },
  };
}
