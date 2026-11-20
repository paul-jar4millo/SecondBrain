// Pure team logic for the refuge: who sits together, which threads join them,
// which handoffs really happened and who is waiting for the owner's OK.
import { PUESTOS } from "./room-life";
import type { Thread } from "../threads/thread-types";

export interface TeamGroup {
  equipoId: string;
  /** Figure ids, leader first. */
  miembros: string[];
}
export interface TeamSeat {
  x: number;
  z: number;
  angle: number;
  mesa: string;
}
export interface ObservedApproval {
  actor: string;
  estado: string;
  vence: number;
}

// Worktables used by teams, in order; far from the spawn point and the Terrace.
const MESAS = ["revisar", "investigar", "programar", "planificar"];
const RADIO = 2;

/** Seat connected live parent/child threads together. */
export function sceneTeams(
  threads: Thread[],
  figures: ReadonlyMap<string, string>,
) {
  const parents = new Map(
    threads.map((thread) => [thread.id, thread.parentId]),
  );
  const groups = new Map<string, Set<string>>();
  const lines: { de: string; a: string }[] = [];
  for (const thread of threads) {
    const child = figures.get(thread.id);
    const parent = thread.parentId ? figures.get(thread.parentId) : undefined;
    if (!child || !parent || !thread.parentId) continue;
    let root = thread.parentId;
    while (parents.get(root) && figures.has(parents.get(root)!))
      root = parents.get(root)!;
    const group = groups.get(root) ?? new Set([figures.get(root)!]);
    group.add(parent);
    group.add(child);
    groups.set(root, group);
    lines.push({ de: parent, a: child });
  }
  return {
    grupos: [...groups].map(([equipoId, members]) => ({
      equipoId,
      miembros: [...members],
    })),
    hilos: lines,
  };
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

/** Base figures whose agent has an approval still pending (not expired). */
export function figurasEsperandoOk(approvals: ObservedApproval[], now: number) {
  const ids = new Set<string>();
  for (const a of approvals) {
    const m = /^agente:(ambar|menta|lira|marina)$/.exec(a.actor || "");
    if (m && a.estado === "pendiente" && a.vence > now) ids.add(m[1]);
  }
  return ids;
}
