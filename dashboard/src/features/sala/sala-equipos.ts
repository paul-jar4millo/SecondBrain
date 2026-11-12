// Pure team logic for the refuge: who sits together, which threads join them,
// which handoffs really happened and who is waiting for the owner's OK.
import { PUESTOS } from "./sala-life";
import { figuraDeSesion, type SesionObservada } from "./sala-sesiones";

export interface GrupoEquipo {
  equipoId: string;
  /** Figure ids, leader first. */
  miembros: string[];
}
export interface Hilo {
  equipoId: string;
  /** Leader figure (or the parent figure) and child figure. */
  de: string;
  a: string;
  hijaSesionId: string;
}
export interface PuestoEquipo {
  x: number;
  z: number;
  angle: number;
  mesa: string;
}
export interface RelevoReal {
  id: string;
  tipo: string;
  de: string;
  para: string;
}
export interface AprobacionObservada {
  actor: string;
  estado: string;
  vence: number;
}

const ACTIVA = new Set(["pendiente", "trabajando"]);
// Worktables used by teams, in order; far from the spawn point and the Terrace.
const MESAS = ["revisar", "investigar", "programar", "planificar"];
const RADIO = 2;

const activas = (sesiones: SesionObservada[]) =>
  sesiones.filter((s) => ACTIVA.has(s.estado) && figuraDeSesion(s));

/** Teams with at least two live figures, and one thread per live child. */
export function equiposEscena(sesiones: SesionObservada[]): {
  grupos: GrupoEquipo[];
  hilos: Hilo[];
} {
  const vivas = activas(sesiones).filter((s) => s.equipoId);
  const porEquipo = new Map<string, SesionObservada[]>();
  for (const s of vivas) {
    const lista = porEquipo.get(s.equipoId!) || [];
    lista.push(s);
    porEquipo.set(s.equipoId!, lista);
  }
  const grupos: GrupoEquipo[] = [];
  const hilos: Hilo[] = [];
  for (const [equipoId, miembros] of porEquipo) {
    if (miembros.length < 2) continue;
    const orden = [
      ...miembros.filter((s) => !s.padreId),
      ...miembros.filter((s) => s.padreId),
    ];
    grupos.push({
      equipoId,
      miembros: orden.map((s) => figuraDeSesion(s)!),
    });
    for (const hija of miembros) {
      const padre = miembros.find((s) => s.id === hija.padreId);
      if (padre)
        hilos.push({
          equipoId,
          de: figuraDeSesion(padre)!,
          a: figuraDeSesion(hija)!,
          hijaSesionId: hija.id,
        });
    }
  }
  return { grupos, hilos };
}

const redondear = (n: number) => Math.round(n * 1000) / 1000;

/** Seats every member of each team around one worktable, facing it. */
export function puestosEquipo(grupos: GrupoEquipo[]) {
  const puestos = new Map<string, PuestoEquipo>();
  grupos.forEach((grupo, i) => {
    const mesa = MESAS[i % MESAS.length];
    const centro = PUESTOS[mesa];
    const n = grupo.miembros.length;
    grupo.miembros.forEach((figura, k) => {
      const t = Math.PI / 2 + (k * 2 * Math.PI) / n;
      const x = centro.x + Math.cos(t) * RADIO;
      const z = centro.z + Math.sin(t) * RADIO;
      puestos.set(figura, {
        x: redondear(x),
        z: redondear(z),
        angle: redondear(Math.atan2(centro.x - x, centro.z - z)),
        mesa,
      });
    });
  });
  return puestos;
}

/**
 * Handoffs recorded by the launcher that the room has not played yet. Both
 * ends must be live figures; every id seen is returned so it is never replayed.
 */
export function relevosNuevos(
  sesiones: SesionObservada[],
  vistos: ReadonlySet<string>,
): { nuevos: RelevoReal[]; ids: string[] } {
  const vivas = activas(sesiones);
  const ids: string[] = [];
  const nuevos: RelevoReal[] = [];
  for (const s of sesiones) {
    const r = s.relevo;
    if (!r?.id) continue;
    ids.push(r.id);
    if (vistos.has(r.id)) continue;
    const de = vivas.find((x) => x.id === s.id);
    const para = vivas.find((x) => x.id === r.para);
    if (de && para && de !== para)
      nuevos.push({
        id: r.id,
        tipo: r.tipo,
        de: figuraDeSesion(de)!,
        para: figuraDeSesion(para)!,
      });
  }
  return { nuevos, ids };
}

/** Base figures whose agent has an approval still pending (not expired). */
export function figurasEsperandoOk(
  aprobaciones: AprobacionObservada[],
  ahora: number,
) {
  const ids = new Set<string>();
  for (const a of aprobaciones) {
    const m = /^agente:(ambar|menta|lira|marina)$/.exec(a.actor || "");
    if (m && a.estado === "pendiente" && a.vence > ahora) ids.add(m[1]);
  }
  return ids;
}
