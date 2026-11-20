import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const FORMATO = 1;
const IMAGENES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
const DOCUMENTOS = [".md", ".json", ".csv"];

/**
 * Proyecto Mundo Hipotético. Solo lee el paquete que publica el repositorio del
 * canal (ver docs/modules/dashboard.md); no conoce sus rutas ni ejecuta nada.
 * Briefs, encargos y notas de agentes son de Second Brain y viven en DATA_DIR.
 */
export function createMundo(dataDirectory, Failure, paqueteDirectory) {
  const directorio = paqueteDirectory || path.join(dataDirectory, "mundo");
  const estadoFile = path.join(dataDirectory, "mundo-estado.json");
  let estado = null;

  async function leerEstado() {
    if (estado) return estado;
    const texto = await readFile(estadoFile, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    // Un estado dañado se conserva: falla el proyecto, nunca se sustituye por uno vacío.
    estado = {
      agents: {},
      tasks: [],
      briefs: [],
      ...(texto ? JSON.parse(texto) : {}),
    };
    return estado;
  }
  let writes = Promise.resolve();
  function guardarEstado() {
    const content = JSON.stringify(estado, null, 2);
    const writing = writes.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(estadoFile + ".tmp", content);
      await rename(estadoFile + ".tmp", estadoFile);
    });
    writes = writing.catch(() => {});
    return writing;
  }
  async function paquete() {
    const texto = await readFile(
      path.join(directorio, "paquete.json"),
      "utf8",
    ).catch(() => null);
    if (!texto)
      throw new Failure(
        "Aún no hay datos del canal. Publícalos con npm run publicar:panel en Mundo Hipotético.",
        503,
      );
    const datos = JSON.parse(texto);
    if (datos.formato !== FORMATO)
      throw new Failure(
        "El paquete del canal tiene otro formato. Actualiza Second Brain o vuelve a publicarlo.",
        503,
      );
    return datos;
  }
  async function archivo(ruta, extensiones) {
    if (typeof ruta !== "string" || !ruta || ruta.includes("\0"))
      throw new Failure("Ruta inválida.", 400);
    const noDisponible = () => {
      throw new Failure("El archivo no está en el paquete.", 404);
    };
    const base = await realpath(path.join(directorio, "archivos")).catch(
      noDisponible,
    );
    const real = await realpath(path.resolve(base, ruta)).catch(noDisponible);
    if (!real.startsWith(base + path.sep))
      throw new Failure("Archivo fuera del paquete.", 403);
    if (!extensiones.includes(path.extname(real).toLowerCase()))
      throw new Failure("Formato no permitido.", 403);
    return real;
  }
  const texto = (valor, maximo = 2000) => {
    if (typeof valor !== "string" || !valor.trim() || valor.length > maximo)
      throw new Failure(
        "Completa el texto y respeta el límite de caracteres.",
        400,
      );
    return valor.trim();
  };

  return {
    async leer() {
      const datos = await paquete();
      const state = await leerEstado();
      return {
        ...datos,
        scannedAt: datos.generado,
        state,
        videos: datos.videos.map((v) => ({
          ...v,
          poster: v.poster
            ? "/api/v1/mundo/media?path=" + encodeURIComponent(v.poster)
            : null,
        })),
        agents: datos.agents.map((a) => ({
          ...a,
          enabled: state.agents[a.id]?.enabled !== false,
          notes: state.agents[a.id]?.notes || "",
        })),
      };
    },
    async documento(ruta) {
      const real = await archivo(ruta, DOCUMENTOS);
      return {
        path: ruta,
        text: (await readFile(real, "utf8")).slice(0, 150000),
      };
    },
    async imagen(ruta, response) {
      const real = await archivo(ruta, Object.keys(IMAGENES));
      response.writeHead(200, {
        "Content-Type": IMAGENES[path.extname(real).toLowerCase()],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      });
      const flujo = createReadStream(real);
      flujo.on("error", () => response.destroy());
      response.on("close", () => flujo.destroy());
      flujo.pipe(response);
    },
    async crearBrief(b) {
      const state = await leerEstado();
      const title = texto(b.title, 180),
        brief = texto(b.brief, 8000),
        slug = texto(b.slug, 80);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        throw new Failure(
          "Usa minúsculas sin acentos y guiones para el tema.",
          400,
        );
      const entrada = {
        id: randomUUID(),
        title,
        brief,
        slug,
        createdAt: new Date().toISOString(),
        status: "draft",
      };
      state.briefs.unshift(entrada);
      await guardarEstado();
      return entrada;
    },
    async configurarAgente(b) {
      const state = await leerEstado();
      if (!(await paquete()).agents.some((a) => a.id === b.id))
        throw new Failure("Agente no encontrado.", 404);
      if (
        typeof b.enabled !== "boolean" ||
        typeof b.notes !== "string" ||
        b.notes.length > 8000
      )
        throw new Failure("Configuración inválida.", 400);
      state.agents[b.id] = { enabled: b.enabled, notes: b.notes };
      await guardarEstado();
      return { ok: true };
    },
    async crearEncargo(b) {
      const state = await leerEstado();
      const datos = await paquete();
      if (!datos.agents.some((a) => a.id === b.agentId))
        throw new Failure("Elige un agente válido.", 400);
      if (state.agents[b.agentId]?.enabled === false)
        throw new Failure("Activa el agente antes de asignarle trabajo.", 409);
      if (b.videoId && !datos.videos.some((v) => v.id === b.videoId))
        throw new Failure("No se encontró el video. Actualiza el panel.", 404);
      const encargo = {
        id: randomUUID(),
        agentId: b.agentId,
        videoId: b.videoId || null,
        instruction: texto(b.instruction, 8000),
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      state.tasks.unshift(encargo);
      await guardarEstado();
      return encargo;
    },
    async cambiarEncargo(b) {
      const state = await leerEstado();
      const encargo = state.tasks.find((t) => t.id === b.id);
      if (!encargo || !["completed", "cancelled", "queued"].includes(b.status))
        throw new Failure("No se puede cambiar este encargo.", 400);
      encargo.status = b.status;
      if (b.status === "completed") encargo.completionSource = "manual";
      else delete encargo.completionSource;
      await guardarEstado();
      return encargo;
    },
  };
}
