import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
/** @import { ServerResponse } from "node:http" */

/** @typedef {{ formato: number, generado: string, videos: { id: string, poster?: string | null }[], agents: { id: string }[] }} MundoPackage */
/** @typedef {{ enabled: boolean, notes: string }} MundoAgentConfig */
/** @typedef {{ id: string, title: string, brief: string, slug: string, createdAt: string, status: "draft" }} MundoBrief */
/** @typedef {"queued" | "completed" | "cancelled"} MundoTaskStatus */
/**
 * @typedef {object} MundoTask
 * @property {string} id
 * @property {string} agentId
 * @property {string | null} videoId
 * @property {string} instruction
 * @property {MundoTaskStatus} status
 * @property {string} createdAt
 * @property {"manual"} [completionSource]
 */
/** @typedef {{ agents: Record<string, MundoAgentConfig>, tasks: MundoTask[], briefs: MundoBrief[] }} MundoState */

const FORMAT = 1;
/** @type {Record<string, string>} */
const IMAGES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
const DOCUMENTS = [".md", ".json", ".csv"];

/**
 * Proyecto Mundo Hipotético. Solo lee el paquete que publica el repositorio del
 * canal (ver docs/modules/dashboard.md); no conoce sus rutas ni ejecuta nada.
 * Briefs, encargos y notas de agentes son de Second Brain y viven en DATA_DIR.
 * @param {string} dataDirectory
 * @param {new (message: string, status?: number) => Error} Failure
 * @param {string} [packageDirectory]
 */
export function createWorld(dataDirectory, Failure, packageDirectory) {
  const directory = packageDirectory || path.join(dataDirectory, "mundo");
  const stateFile = path.join(dataDirectory, "mundo-estado.json");
  /** @type {MundoState | null} */
  let estado = null;

  async function readState() {
    if (estado) return estado;
    const text = await readFile(stateFile, "utf8").catch(
      /** @returns {null} */ (e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      },
    );
    // Un estado dañado se conserva: falla el proyecto, nunca se sustituye por uno vacío.
    estado = {
      agents: {},
      tasks: [],
      briefs: [],
      ...(text ? /** @type {Partial<MundoState>} */ (JSON.parse(text)) : {}),
    };
    return estado;
  }
  let writes = Promise.resolve();
  function saveState() {
    const content = JSON.stringify(estado, null, 2);
    const writing = writes.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(stateFile + ".tmp", content);
      await rename(stateFile + ".tmp", stateFile);
    });
    writes = writing.catch(() => {});
    return writing;
  }
  async function paquete() {
    const text = await readFile(
      path.join(directory, "paquete.json"),
      "utf8",
    ).catch(/** @returns {null} */ () => null);
    if (!text)
      throw new Failure(
        "Aún no hay datos del canal. Publícalos con npm run publicar:panel en Mundo Hipotético.",
        503,
      );
    const data = /** @type {MundoPackage} */ (JSON.parse(text));
    if (data.formato !== FORMAT)
      throw new Failure(
        "El paquete del canal tiene otro formato. Actualiza Second Brain o vuelve a publicarlo.",
        503,
      );
    return data;
  }
  /** @param {unknown} ruta @param {string[]} extensions */
  async function file(ruta, extensions) {
    if (typeof ruta !== "string" || !ruta || ruta.includes("\0"))
      throw new Failure("Ruta inválida.", 400);
    const unavailable = () => {
      throw new Failure("El archivo no está en el paquete.", 404);
    };
    const base = await realpath(path.join(directory, "archivos")).catch(
      unavailable,
    );
    const real = await realpath(path.resolve(base, ruta)).catch(unavailable);
    if (!real.startsWith(base + path.sep))
      throw new Failure("Archivo fuera del paquete.", 403);
    if (!extensions.includes(path.extname(real).toLowerCase()))
      throw new Failure("Formato no permitido.", 403);
    return real;
  }
  /** @param {unknown} value */
  const texto = (value, max = 2000) => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Failure(
        "Completa el texto y respeta el límite de caracteres.",
        400,
      );
    return value.trim();
  };

  return {
    async leer() {
      const data = await paquete();
      const state = await readState();
      return {
        ...data,
        scannedAt: data.generado,
        state,
        videos: data.videos.map((v) => ({
          ...v,
          poster: v.poster
            ? "/api/v1/mundo/media?path=" + encodeURIComponent(v.poster)
            : null,
        })),
        agents: data.agents.map((a) => ({
          ...a,
          enabled: state.agents[a.id]?.enabled !== false,
          notes: state.agents[a.id]?.notes || "",
        })),
      };
    },
    /** @param {string | null} ruta */
    async documento(ruta) {
      const real = await file(ruta, DOCUMENTS);
      return {
        path: ruta,
        text: (await readFile(real, "utf8")).slice(0, 150000),
      };
    },
    /** @param {string | null} ruta @param {ServerResponse} response */
    async imagen(ruta, response) {
      const real = await file(ruta, Object.keys(IMAGES));
      response.writeHead(200, {
        "Content-Type": IMAGES[path.extname(real).toLowerCase()],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      });
      const flow = createReadStream(real);
      flow.on("error", () => response.destroy());
      response.on("close", () => flow.destroy());
      flow.pipe(response);
    },
    /** @param {{ title?: unknown, brief?: unknown, slug?: unknown }} b */
    async crearBrief(b) {
      const state = await readState();
      const title = texto(b.title, 180),
        brief = texto(b.brief, 8000),
        slug = texto(b.slug, 80);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        throw new Failure(
          "Usa minúsculas sin acentos y guiones para el tema.",
          400,
        );
      /** @type {MundoBrief} */
      const entry = {
        id: randomUUID(),
        title,
        brief,
        slug,
        createdAt: new Date().toISOString(),
        status: "draft",
      };
      state.briefs.unshift(entry);
      await saveState();
      return entry;
    },
    /** @param {{ id: string, enabled?: unknown, notes?: unknown }} b */
    async configurarAgente(b) {
      const state = await readState();
      if (!(await paquete()).agents.some((a) => a.id === b.id))
        throw new Failure("Agente no encontrado.", 404);
      if (
        typeof b.enabled !== "boolean" ||
        typeof b.notes !== "string" ||
        b.notes.length > 8000
      )
        throw new Failure("Configuración inválida.", 400);
      state.agents[b.id] = { enabled: b.enabled, notes: b.notes };
      await saveState();
      return { ok: true };
    },
    /** @param {{ agentId: string, videoId?: string | null, instruction?: unknown }} b */
    async crearEncargo(b) {
      const state = await readState();
      const data = await paquete();
      if (!data.agents.some((a) => a.id === b.agentId))
        throw new Failure("Elige un agente válido.", 400);
      if (state.agents[b.agentId]?.enabled === false)
        throw new Failure("Activa el agente antes de asignarle trabajo.", 409);
      if (b.videoId && !data.videos.some((v) => v.id === b.videoId))
        throw new Failure("No se encontró el video. Actualiza el panel.", 404);
      /** @type {MundoTask} */
      const task = {
        id: randomUUID(),
        agentId: b.agentId,
        videoId: b.videoId || null,
        instruction: texto(b.instruction, 8000),
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      state.tasks.unshift(task);
      await saveState();
      return task;
    },
    /** @param {{ id: string, status: MundoTaskStatus }} b */
    async cambiarEncargo(b) {
      const state = await readState();
      const task = state.tasks.find((t) => t.id === b.id);
      if (!task || !["completed", "cancelled", "queued"].includes(b.status))
        throw new Failure("No se puede cambiar este encargo.", 400);
      task.status = b.status;
      if (b.status === "completed") task.completionSource = "manual";
      else delete task.completionSource;
      await saveState();
      return task;
    },
  };
}
