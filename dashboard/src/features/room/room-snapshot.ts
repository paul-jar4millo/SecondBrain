// What the scene shows from a team snapshot: agents, flows, relays and unread work.
import { PUESTOS } from "./room-life";
import type { sceneSessions } from "./room-sessions";
import type { AgentsState, TeamState } from "./room-types";
import type { TeamController } from "../team/team-controller";

type Snapshot = ReturnType<TeamController["getSnapshot"]>;
type Observed = ReturnType<typeof sceneSessions> | null;

const FINISHED = ["listo", "error", "cancelado", "interrumpido"];

/**
 * Agents and team state for the scene. Observed launcher sessions win: each
 * live copy becomes a working figure, and the legacy flows are not shown.
 */
export function sceneFromSnapshot(
  snapshot: Snapshot,
  observed: Observed,
): { agents: AgentsState; team: TeamState } {
  if (observed)
    return {
      agents: {
        conectado: true,
        agentes: [
          ...observed.base,
          ...observed.copias.map((c) => ({
            id: c.id,
            ocupada: true,
            ultimo: {
              jobId: c.sesionId,
              estado: "trabajando",
              fase: c.fase,
              actividad: {
                zona: PUESTOS[c.fase || ""]?.zone || "terrace",
                etiqueta: c.etiqueta,
              },
            },
          })),
        ],
      },
      team: { flujos: [], eventos: [] },
    };
  return {
    agents: {
      conectado: snapshot.connected,
      agentes: snapshot.agents.map((a) => ({ ...a, ocupada: !!a.ocupada })),
    },
    team: {
      flujos: snapshot.flows,
      eventos: snapshot.events
        .filter((e) => e.id && e.de && e.para)
        .map((e) => ({
          id: e.id!,
          tipo: e.tipo || "",
          de: e.de!,
          para: e.para!,
          texto: e.texto || "",
        })),
    },
  };
}

/** Finished jobs the owner has not opened yet. */
export function unreadJobs(snapshot: Snapshot, read: string[]) {
  const unread = new Set<string>();
  for (const a of snapshot.agents)
    for (const job of a.historial || (a.ultimo?.fin ? [a.ultimo] : []))
      if (job.jobId && !read.includes(job.jobId)) unread.add(job.jobId);
  for (const f of snapshot.flows)
    for (const job of f.pasos)
      if (
        job.jobId &&
        FINISHED.includes(job.estado) &&
        !read.includes(job.jobId)
      )
        unread.add(job.jobId);
  return unread;
}
