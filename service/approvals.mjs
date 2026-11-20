import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/** @typedef {"aprobada" | "rechazada"} ApprovalDecision */
/** @typedef {ApprovalDecision | "expirada" | "interrumpida"} ApprovalResolution */
/** @typedef {{ requestId: string, aprobacionId: string, decision: ApprovalDecision, por: string, ts: number, resultado: string }} ApprovalReceipt */
/**
 * @typedef {object} ApprovalRecord
 * @property {string} id
 * @property {string} [actor]
 * @property {object} [operacion]
 * @property {"pendiente" | ApprovalResolution} estado
 * @property {number} creada
 * @property {number} vence
 * @property {number} [resuelta]
 * @property {ApprovalReceipt} [recibo]
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A decision that conflicts with the receipt already stored for that approval. */
export class ApprovalConflict extends Error {
  /** @param {ApprovalReceipt} receipt */
  constructor(receipt) {
    super("La solicitud ya fue resuelta con otra decisión.");
    this.recibo = receipt;
  }
}
/**
 * @param {string} dir
 * @param {{ reloj?: () => number, plazoMs?: number, onChange?: () => void }} [options]
 */
export async function createApprovalQueue(
  dir,
  {
    reloj: clock = Date.now,
    plazoMs: termMs = 1800000,
    onChange = () => {},
  } = {},
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const archivo = path.join(dir, "aprobaciones.jsonl");
  /** @type {Map<string, ApprovalRecord>} */
  const registros = new Map();
  // requestId -> receipt, rebuilt from the journal: a retry survives a restart.
  /** @type {Map<string, ApprovalReceipt>} */
  const receipts = new Map();
  /** @type {Map<string, (estado: ApprovalResolution) => void>} */
  const waits = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let cerrado = false;
  const content = await readFile(archivo, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    /** @type {ApprovalRecord} */
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch (error) {
      if (i === lines.length - 1 && !content.endsWith("\n")) break;
      throw error;
    }
    if (!event?.id || !event.estado)
      throw new Error("Journal de aprobaciones inválido");
    registros.set(event.id, event);
  }
  const cutoff = clock() - 90 * 86400000;
  for (const [id, registry] of registros) {
    if (
      registry.estado !== "pendiente" &&
      (registry.resuelta ?? registry.creada) < cutoff
    )
      registros.delete(id);
    else if (registry.recibo)
      receipts.set(registry.recibo.requestId, registry.recibo);
  }
  await writeFile(
    archivo + ".tmp",
    [...registros.values()].map((r) => JSON.stringify(r) + "\n").join(""),
    { mode: 0o600 },
  );
  await rename(archivo + ".tmp", archivo);
  /** @param {ApprovalRecord} registro */
  async function save(registro) {
    const file = await open(archivo, "a", 0o600);
    try {
      await file.writeFile(JSON.stringify(registro) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    registros.set(registro.id, registro);
    if (registro.recibo)
      receipts.set(registro.recibo.requestId, registro.recibo);
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
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }
  // The state and its receipt are one journal line, so they are written together or not at all.
  /** @param {ApprovalRecord} r @param {ApprovalResolution} estado @param {ApprovalReceipt} [recibo] */
  async function change(r, estado, recibo) {
    const next = {
      ...r,
      estado,
      resuelta: clock(),
      ...(recibo ? { recibo } : {}),
    };
    await save(next);
    clearTimeout(timers.get(r.id));
    timers.delete(r.id);
    waits.get(r.id)?.(estado);
    waits.delete(r.id);
  }
  /** @param {ApprovalRecord} r */
  function schedule(r) {
    const timer = setTimeout(
      () => {
        serial(async () => {
          const current = registros.get(r.id);
          if (!current || current.estado !== "pendiente") return;
          if (clock() >= current.vence) await change(current, "expirada");
          else schedule(current);
        }).catch(() => {});
      },
      Math.max(1, r.vence - clock()),
    );
    timer.unref();
    timers.set(r.id, timer);
  }
  for (const r of registros.values()) {
    if (r.estado === "pendiente") {
      if (clock() >= r.vence) await change(r, "expirada");
      else await change(r, "interrumpida");
    }
  }
  return {
    listar: () => structuredClone([...registros.values()]),
    /** @param {{ actor?: unknown, operacion?: unknown }} input */
    solicitar({ actor, operacion: operation }) {
      return serial(async () => {
        if (
          cerrado ||
          typeof actor !== "string" ||
          !operation ||
          typeof operation !== "object"
        )
          throw new Error("Solicitud inválida");
        const inicio = clock();
        /** @type {ApprovalRecord} */
        const registro = {
          id: randomUUID(),
          actor,
          operacion: structuredClone(operation),
          estado: "pendiente",
          creada: inicio,
          vence: inicio + termMs,
        };
        await save(registro);
        /** @type {Promise<ApprovalResolution>} */
        const wait = new Promise((resolve) => waits.set(registro.id, resolve));
        schedule(registro);
        return { id: registro.id, esperar: wait };
      });
    },
    /**
     * Resolves a pending request once. The same `requestId` again returns the
     * stored receipt (`repetido`); a different one on a resolved request, or
     * the same one on another request, raises ApprovalConflict with the receipt.
     * @param {string} id
     * @param {unknown} approve
     * @param {{ requestId?: string, por?: unknown }} [options]
     */
    decidir(id, approve, { requestId, por = "app" } = {}) {
      return serial(async () => {
        if (
          cerrado ||
          typeof approve !== "boolean" ||
          (requestId !== undefined &&
            (typeof requestId !== "string" || !UUID.test(requestId)))
        )
          throw new Error("Decisión inválida");
        const r = registros.get(id);
        if (r?.recibo) {
          if (requestId && r.recibo.requestId === requestId)
            return { recibo: structuredClone(r.recibo), repetido: true };
          throw new ApprovalConflict(structuredClone(r.recibo));
        }
        const previous = requestId && receipts.get(requestId);
        if (previous) throw new ApprovalConflict(structuredClone(previous));
        if (!r || r.estado !== "pendiente")
          throw new Error("Solicitud no pendiente");
        if (clock() >= r.vence) {
          await change(r, "expirada");
          throw new Error("Solicitud expirada");
        }
        const decision = approve ? "aprobada" : "rechazada";
        /** @type {ApprovalReceipt} */
        const receipt = {
          requestId: requestId ?? randomUUID(),
          aprobacionId: id,
          decision,
          por: String(por).slice(0, 60),
          ts: clock(),
          resultado: approve
            ? "Aprobada: la operación continúa."
            : "Rechazada: la operación no se aplicó.",
        };
        await change(r, decision, receipt);
        return { recibo: structuredClone(receipt), repetido: false };
      });
    },
    /** @param {string} id @param {string} result */
    finalizar(id, result) {
      return serial(async () => {
        const r = registros.get(id);
        if (!r?.recibo) throw new Error("Solicitud sin recibo");
        await save({ ...r, recibo: { ...r.recibo, resultado: result } });
      });
    },
    async cerrar() {
      cerrado = true;
      await queue;
      for (const r of registros.values()) {
        if (r.estado === "pendiente") await change(r, "interrumpida");
      }
      for (const timer of timers.values()) clearTimeout(timer);
      for (const resolver of waits.values()) resolver("interrumpida");
      timers.clear();
      waits.clear();
    },
  };
}
