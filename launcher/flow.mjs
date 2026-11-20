import { coalesce } from "./harness.mjs";
import { INITIAL_BATCH } from "./items.mjs";

/** @import { TerminalEvent } from "./types.d.ts" */

const HEARTBEAT = 15000;
// A reader this far behind is cut off; it reconnects and gets a fresh snapshot.
const MAX_PENDING = 4 * 1024 * 1024;

/**
 * Server-sent stream of one harness: `snapshot` (clean screen state) followed by
 * `salida` deltas, structured `items`, `estado` and heartbeats. The reader keeps
 * `seq` continuity; any gap means reconnecting for a new snapshot.
 * Throws before writing anything when the session has no terminal.
 * @param {{ res: import("node:http").ServerResponse, id: string, ejecutor: ReturnType<typeof import("./executor.mjs").createExecutor>, registro: import("./session-types.d.ts").SessionRegistry, items?: ReturnType<typeof import("./items.mjs").createItems>, ms?: number, latido?: number }} options
 */
export function serveFlow({
  res,
  id,
  ejecutor,
  registro: registry,
  items,
  ms = 24,
  latido: heartbeat = HEARTBEAT,
}) {
  let source = ejecutor.flujo(id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let cerrado = false;
  /**
   * @param {string} evento
   * @param {unknown} data
   */
  const send = (evento, data) => {
    if (cerrado) return;
    if (res.writableLength > MAX_PENDING) return close();
    res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const coalescing = coalesce((batch) => send("salida", batch), ms);
  /** @type {Extract<TerminalEvent, { tipo: "salida" } >[]} */
  let queue = [];
  let vivo = false;
  let round = 0;
  let unsubscribe = () => {};

  async function restart() {
    const esta = ++round;
    vivo = false;
    coalescing.cancelar();
    queue = [];
    const instantanea = await source.snapshot();
    if (cerrado || esta !== round) return;
    send("snapshot", {
      ...instantanea,
      activa: source.activa(),
      generacion: source.generacion,
    });
    for (const event of queue)
      if (event.seq > instantanea.seq)
        coalescing.agregar(event.datos, event.seq);
    queue = [];
    vivo = true;
  }
  function link() {
    unsubscribe();
    unsubscribe = source.suscribir((event) => {
      if (event.tipo === "tamano") void restart();
      else if (event.tipo === "salida") {
        if (vivo) coalescing.agregar(event.datos, event.seq);
        else queue.push(event);
      }
    });
  }

  let lastState = "";
  const estado = () => {
    const session = registry.leer().find((s) => s.id === id);
    if (!session) return;
    const actual = {
      estado: session.estado,
      activa: source.activa(),
      ultimaAccion: session.ultimaAccion ?? null,
    };
    const fingerprint = JSON.stringify(actual);
    if (fingerprint === lastState) return;
    lastState = fingerprint;
    send("estado", actual);
  };
  const unsubscribeRegistry = registry.subscribe(() => {
    if (cerrado) return;
    try {
      const created = ejecutor.flujo(id);
      if (created.generacion !== source.generacion) {
        // The program was started again: a new screen, a new snapshot.
        source = created;
        link();
        void restart();
      } else source = created;
    } catch {
      /* the session was deleted; the stream ends below */
    }
    estado();
  });
  const sub = items?.suscribir(id, (list) =>
    send("items", { reemplazar: false, items: list }),
  );
  const pulse = setInterval(() => {
    if (!cerrado) res.write(": latido\n\n");
  }, heartbeat);
  pulse.unref();

  function close() {
    if (cerrado) return;
    cerrado = true;
    clearInterval(pulse);
    coalescing.cancelar();
    unsubscribe();
    unsubscribeRegistry();
    sub?.off();
    res.end();
  }
  res.on("close", close);

  res.write(": conectado\n\n");
  link();
  void restart().then(() => {
    if (cerrado) return;
    send("items", {
      reemplazar: true,
      items: sub?.ultimos(INITIAL_BATCH) ?? [],
    });
    estado();
  });
  return close;
}
