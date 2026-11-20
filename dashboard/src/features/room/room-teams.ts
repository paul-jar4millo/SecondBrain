// Pure team logic for the refuge: who sits together, which threads join them,
// which handoffs really happened and who is waiting for the owner's OK.
import { PUESTOS } from "./room-life";
import { sessionFigure, type ObservedSession } from "./room-sessions";

export interface TeamGroup {
  equipoId: string;
  /** Figure ids, leader first. */
  miembros: string[];
}
export interface Thread {
  equipoId: string;
  /** Leader figure (or the parent figure) and child figure. */
  de: string;
  a: string;
  hijaSesionId: string;
}
export interface TeamSeat {
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
export interface ObservedApproval {
  actor: string;
  estado: string;
  vence: number;
}

const ACTIVE = new Set(["pendiente", "trabajando"]);
// Worktables used by teams, in order; far from the spawn point and the Terrace.
const MESAS = ["revisar", "investigar", "programar", "planificar"];
const RADIO = 2;

const active = (sessions: ObservedSession[]) =>
  sessions.filter((s) => ACTIVE.has(s.estado) && sessionFigure(s));

/** Teams with at least two live figures, and one thread per live child. */
export function sceneTeams(sessions: ObservedSession[]): {
  grupos: TeamGroup[];
  hilos: Thread[];
} {
  const vivas = active(sessions).filter((s) => s.equipoId);
  const byTeam = new Map<string, ObservedSession[]>();
  for (const s of vivas) {
    const list = byTeam.get(s.equipoId!) || [];
    list.push(s);
    byTeam.set(s.equipoId!, list);
  }
  const groups: TeamGroup[] = [];
  const hilos: Thread[] = [];
  for (const [teamId, members] of byTeam) {
    if (members.length < 2) continue;
    const orden = [
      ...members.filter((s) => !s.padreId),
      ...members.filter((s) => s.padreId),
    ];
    groups.push({
      equipoId: teamId,
      miembros: orden.map((s) => sessionFigure(s)!),
    });
    for (const hija of members) {
      const parent = members.find((s) => s.id === hija.padreId);
      if (parent)
        hilos.push({
          equipoId: teamId,
          de: sessionFigure(parent)!,
          a: sessionFigure(hija)!,
          hijaSesionId: hija.id,
        });
    }
  }
  return { grupos: groups, hilos };
}

const redondear = (n: number) => Math.round(n * 1000) / 1000;

/** Seats every member of each team around one worktable, facing it. */
export function teamSeats(groups: TeamGroup[]) {
  const puestos = new Map<string, TeamSeat>();
  groups.forEach((grupo, i) => {
    const table = MESAS[i % MESAS.length];
    const centro = PUESTOS[table];
    const n = grupo.miembros.length;
    grupo.miembros.forEach((figura, k) => {
      const t = Math.PI / 2 + (k * 2 * Math.PI) / n;
      const x = centro.x + Math.cos(t) * RADIO;
      const z = centro.z + Math.sin(t) * RADIO;
      puestos.set(figura, {
        x: redondear(x),
        z: redondear(z),
        angle: redondear(Math.atan2(centro.x - x, centro.z - z)),
        mesa: table,
      });
    });
  });
  return puestos;
}

/**
 * Handoffs recorded by the launcher that the room has not played yet. Both
 * ends must be live figures; every id seen is returned so it is never replayed.
 */
export function newHandoffs(
  sessions: ObservedSession[],
  vistos: ReadonlySet<string>,
): { nuevos: RelevoReal[]; ids: string[] } {
  const vivas = active(sessions);
  const ids: string[] = [];
  const created: RelevoReal[] = [];
  for (const s of sessions) {
    const r = s.relevo;
    if (!r?.id) continue;
    ids.push(r.id);
    if (vistos.has(r.id)) continue;
    const de = vivas.find((x) => x.id === s.id);
    const para = vivas.find((x) => x.id === r.para);
    if (de && para && de !== para)
      created.push({
        id: r.id,
        tipo: r.tipo,
        de: sessionFigure(de)!,
        para: sessionFigure(para)!,
      });
  }
  return { nuevos: created, ids };
}

/** Base figures whose agent has an approval still pending (not expired). */
export function figurasEsperandoOk(approvals: ObservedApproval[], now: number) {
  const ids = new Set<string>();
  for (const a of approvals) {
    const m = /^agente:(ambar|menta|lira|marina)$/.exec(a.actor || "");
    if (m && a.estado === "pendiente" && a.vence > now) ids.add(m[1]);
  }
  return ids;
}
