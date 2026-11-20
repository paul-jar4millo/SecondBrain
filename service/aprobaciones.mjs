import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A decision that conflicts with the receipt already stored for that approval. */
export class ConflictoAprobacion extends Error {
  constructor(recibo) {
    super("La solicitud ya fue resuelta con otra decisión.");
    this.recibo = recibo;
  }
}
export async function crearColaAprobaciones(
  dir,
  {
    reloj = Date.now,
    plazoMs = 1800000,
    onChange = /** @type {(...args: any[]) => any} */ (() => {}),
  } = /** @type {any} */ ({}),
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const archivo = path.join(dir, "aprobaciones.jsonl");
  const registros = new Map();
  // requestId -> receipt, rebuilt from the journal: a retry survives a restart.
  const recibos = new Map();
  const esperas = new Map();
  const timers = new Map();
  /** @type {Promise<unknown>} */
  let cola = Promise.resolve();
  let cerrado = false;
  const contenido = await readFile(archivo, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const lines = contenido.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let evento;
    try {
      evento = JSON.parse(lines[i]);
    } catch (error) {
      if (i === lines.length - 1 && !contenido.endsWith("\n")) break;
      throw error;
    }
    if (!evento?.id || !evento.estado)
      throw new Error("Journal de aprobaciones inválido");
    registros.set(evento.id, evento);
  }
  const cutoff = reloj() - 90 * 86400000;
  for (const [id, registro] of registros) {
    if (
      registro.estado !== "pendiente" &&
      (registro.resuelta ?? registro.creada) < cutoff
    )
      registros.delete(id);
    else if (registro.recibo)
      recibos.set(registro.recibo.requestId, registro.recibo);
  }
  await writeFile(
    archivo + ".tmp",
    [...registros.values()].map((r) => JSON.stringify(r) + "\n").join(""),
    { mode: 0o600 },
  );
  await rename(archivo + ".tmp", archivo);
  async function guardar(registro) {
    const file = await open(archivo, "a", 0o600);
    try {
      await file.writeFile(JSON.stringify(registro) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    registros.set(registro.id, registro);
    if (registro.recibo)
      recibos.set(registro.recibo.requestId, registro.recibo);
    try {
      onChange();
    } catch {
      /* observers cannot reverse a journalled decision */
    }
  }
  /**
   * Runs fn after every previously queued call.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const siguiente = cola.then(fn);
    cola = siguiente.catch(() => {});
    return siguiente;
  }
  // The state and its receipt are one journal line, so they are written together or not at all.
  async function cambiar(r, estado, recibo) {
    const siguiente = {
      ...r,
      estado,
      resuelta: reloj(),
      ...(recibo ? { recibo } : {}),
    };
    await guardar(siguiente);
    clearTimeout(timers.get(r.id));
    timers.delete(r.id);
    esperas.get(r.id)?.(estado);
    esperas.delete(r.id);
  }
  function programar(r) {
    const timer = setTimeout(
      () => {
        serial(async () => {
          const vigente = registros.get(r.id);
          if (!vigente || vigente.estado !== "pendiente") return;
          if (reloj() >= vigente.vence) await cambiar(vigente, "expirada");
          else programar(vigente);
        }).catch(() => {});
      },
      Math.max(1, r.vence - reloj()),
    );
    timer.unref();
    timers.set(r.id, timer);
  }
  for (const r of registros.values()) {
    if (r.estado === "pendiente") {
      if (reloj() >= r.vence) await cambiar(r, "expirada");
      else await cambiar(r, "interrumpida");
    }
  }
  return {
    listar: () => structuredClone([...registros.values()]),
    solicitar({ actor, operacion }) {
      return serial(async () => {
        if (
          cerrado ||
          typeof actor !== "string" ||
          !operacion ||
          typeof operacion !== "object"
        )
          throw new Error("Solicitud inválida");
        const inicio = reloj();
        const registro = {
          id: randomUUID(),
          actor,
          operacion: structuredClone(operacion),
          estado: "pendiente",
          creada: inicio,
          vence: inicio + plazoMs,
        };
        await guardar(registro);
        const esperar = new Promise((resolve) =>
          esperas.set(registro.id, resolve),
        );
        programar(registro);
        return { id: registro.id, esperar };
      });
    },
    /**
     * Resolves a pending request once. The same `requestId` again returns the
     * stored receipt (`repetido`); a different one on a resolved request, or
     * the same one on another request, raises ConflictoAprobacion with the receipt.
     */
    decidir(id, aprobar, { requestId, por = "app" } = /** @type {any} */ ({})) {
      return serial(async () => {
        if (
          cerrado ||
          typeof aprobar !== "boolean" ||
          (requestId !== undefined &&
            (typeof requestId !== "string" || !UUID.test(requestId)))
        )
          throw new Error("Decisión inválida");
        const r = registros.get(id);
        if (r?.recibo) {
          if (requestId && r.recibo.requestId === requestId)
            return { recibo: structuredClone(r.recibo), repetido: true };
          throw new ConflictoAprobacion(structuredClone(r.recibo));
        }
        const previo = requestId && recibos.get(requestId);
        if (previo) throw new ConflictoAprobacion(structuredClone(previo));
        if (!r || r.estado !== "pendiente")
          throw new Error("Solicitud no pendiente");
        if (reloj() >= r.vence) {
          await cambiar(r, "expirada");
          throw new Error("Solicitud expirada");
        }
        const decision = aprobar ? "aprobada" : "rechazada";
        const recibo = {
          requestId: requestId ?? randomUUID(),
          aprobacionId: id,
          decision,
          por: String(por).slice(0, 60),
          ts: reloj(),
          resultado: aprobar
            ? "Aprobada: la operación continúa."
            : "Rechazada: la operación no se aplicó.",
        };
        await cambiar(r, decision, recibo);
        return { recibo: structuredClone(recibo), repetido: false };
      });
    },
    finalizar(id, resultado) {
      return serial(async () => {
        const r = registros.get(id);
        if (!r?.recibo) throw new Error("Solicitud sin recibo");
        await guardar({ ...r, recibo: { ...r.recibo, resultado } });
      });
    },
    async cerrar() {
      cerrado = true;
      await cola;
      for (const r of registros.values()) {
        if (r.estado === "pendiente") await cambiar(r, "interrumpida");
      }
      for (const timer of timers.values()) clearTimeout(timer);
      for (const resolver of esperas.values()) resolver("interrumpida");
      timers.clear();
      esperas.clear();
    },
  };
}
