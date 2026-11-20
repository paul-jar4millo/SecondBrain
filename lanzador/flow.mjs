import { coalescer } from "./harness.mjs";
import { LOTE_INICIAL } from "./items.mjs";

/** @import { TerminalEvent } from "./types.d.ts" */

const LATIDO = 15000;
// A reader this far behind is cut off; it reconnects and gets a fresh snapshot.
const MAX_PENDIENTE = 4 * 1024 * 1024;

/**
 * Server-sent stream of one harness: `snapshot` (clean screen state) followed by
 * `salida` deltas, structured `items`, `estado` and heartbeats. The reader keeps
 * `seq` continuity; any gap means reconnecting for a new snapshot.
 * Throws before writing anything when the session has no terminal.
 * @param {{ res: import("node:http").ServerResponse, id: string, ejecutor: ReturnType<typeof import("./executor.mjs").crearEjecutor>, registro: import("./session-types.d.ts").SessionRegistry, items?: ReturnType<typeof import("./items.mjs").crearItems>, ms?: number, latido?: number }} options
 */
export function servirFlujo({
  res,
  id,
  ejecutor,
  registro,
  items,
  ms = 24,
  latido = LATIDO,
}) {
  let fuente = ejecutor.flujo(id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let cerrado = false;
  /**
   * @param {string} evento
   * @param {unknown} datos
   */
  const enviar = (evento, datos) => {
    if (cerrado) return;
    if (res.writableLength > MAX_PENDIENTE) return cerrar();
    res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
  };
  const coalescencia = coalescer((lote) => enviar("salida", lote), ms);
  /** @type {Extract<TerminalEvent, { tipo: "salida" } >[]} */
  let cola = [];
  let vivo = false;
  let ronda = 0;
  let desuscribir = () => {};

  async function reiniciar() {
    const esta = ++ronda;
    vivo = false;
    coalescencia.cancelar();
    cola = [];
    const instantanea = await fuente.snapshot();
    if (cerrado || esta !== ronda) return;
    enviar("snapshot", {
      ...instantanea,
      activa: fuente.activa(),
      generacion: fuente.generacion,
    });
    for (const evento of cola)
      if (evento.seq > instantanea.seq)
        coalescencia.agregar(evento.datos, evento.seq);
    cola = [];
    vivo = true;
  }
  function enlazar() {
    desuscribir();
    desuscribir = fuente.suscribir((evento) => {
      if (evento.tipo === "tamano") void reiniciar();
      else if (evento.tipo === "salida") {
        if (vivo) coalescencia.agregar(evento.datos, evento.seq);
        else cola.push(evento);
      }
    });
  }

  let ultimoEstado = "";
  const estado = () => {
    const sesion = registro.leer().find((s) => s.id === id);
    if (!sesion) return;
    const actual = {
      estado: sesion.estado,
      activa: fuente.activa(),
      ultimaAccion: sesion.ultimaAccion ?? null,
    };
    const huella = JSON.stringify(actual);
    if (huella === ultimoEstado) return;
    ultimoEstado = huella;
    enviar("estado", actual);
  };
  const dejarRegistro = registro.subscribe(() => {
    if (cerrado) return;
    try {
      const nueva = ejecutor.flujo(id);
      if (nueva.generacion !== fuente.generacion) {
        // The program was started again: a new screen, a new snapshot.
        fuente = nueva;
        enlazar();
        void reiniciar();
      } else fuente = nueva;
    } catch {
      /* the session was deleted; the stream ends below */
    }
    estado();
  });
  const sub = items?.suscribir(id, (lista) =>
    enviar("items", { reemplazar: false, items: lista }),
  );
  const pulso = setInterval(() => {
    if (!cerrado) res.write(": latido\n\n");
  }, latido);
  pulso.unref();

  function cerrar() {
    if (cerrado) return;
    cerrado = true;
    clearInterval(pulso);
    coalescencia.cancelar();
    desuscribir();
    dejarRegistro();
    sub?.off();
    res.end();
  }
  res.on("close", cerrar);

  res.write(": conectado\n\n");
  enlazar();
  void reiniciar().then(() => {
    if (cerrado) return;
    enviar("items", {
      reemplazar: true,
      items: sub?.ultimos(LOTE_INICIAL) ?? [],
    });
    estado();
  });
  return cerrar;
}
