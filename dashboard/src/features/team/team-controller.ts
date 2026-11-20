export type AgentId = "ambar" | "menta" | "lira" | "marina";
import { sesionesEscena, type SesionObservada } from "../room/room-sessions";
export type TeamTab = "vivo";
export interface AgentTarget {
  agentId: string;
  projectId?: string;
  taskId?: string;
  chatId?: string;
}
export interface TeamTarget {
  tab?: TeamTab;
  projectId?: string;
  jobId?: string;
}
export interface Configuration {
  modelo?: string;
  esfuerzo?: string;
}
export interface TeamEvent {
  id?: string;
  en?: string;
  tipo?: string;
  texto?: string;
  etiqueta?: string;
  project?: string;
  flowId?: string;
  de?: string;
  para?: string;
  paso?: number;
  jobId?: string;
}
export interface TeamJob {
  jobId?: string;
  estado: string;
  project?: string;
  fase?: string;
  agente?: string;
  instruction?: string;
  respuesta?: string;
  error?: string;
  truncada?: boolean;
  inicio?: string;
  fin?: string;
  configuracion?: Configuration;
  actividad?: { zona: string; etiqueta: string };
  eventos?: TeamEvent[];
}
export interface TeamAgent {
  id: string;
  ocupada?: boolean;
  nombre?: string;
  proveedor?: string;
  acceso?: string;
  ultimo?: TeamJob | null;
  historial?: TeamJob[];
  configuracion?: Configuration;
  personaje?: { zona: string };
  observado?: string;
  ventanas?: Record<string, { usado?: number; reinicia?: string }>;
  saldo?: { total: string; moneda: string };
  contextos?: Record<
    string,
    { usados?: number; limite?: number; estimado?: boolean }
  >;
}
export interface TeamStep extends TeamJob {
  agente: string;
  nombre: string;
  zona: string;
}
export interface TeamFlow {
  id: string;
  estado: string;
  indice: number;
  project?: string;
  instruction?: string;
  inicio?: string;
  fin?: string;
  error?: string;
  veredicto?: "aprobado" | "rechazado" | "sin-veredicto" | null;
  bloqueo?: { paso: number; pregunta: string };
  pasos: TeamStep[];
  relevos?: TeamEvent[];
}
export interface TeamSnapshot {
  agents: TeamAgent[];
  flows: TeamFlow[];
  events: TeamEvent[];
  connected: boolean;
  loaded: boolean;
  error: string;
  pending: string[];
  sessions: SesionObservada[] | null;
}
export type TeamTransport = (path: string, body?: unknown) => Promise<unknown>;

export function collectJobs(agents: TeamAgent[], flows: TeamFlow[]) {
  const jobs = new Map<string, TeamJob>();
  for (const f of flows)
    for (const s of f.pasos) {
      if (
        s.jobId &&
        ["listo", "error", "cancelado", "interrumpido"].includes(s.estado)
      )
        jobs.set(s.jobId, {
          ...s,
          fase: s.nombre,
          project: f.project,
          instruction: f.instruction,
          fin: s.fin || f.fin || f.inicio,
        });
    }
  for (const a of agents)
    for (const j of a.historial?.length
      ? a.historial
      : a.ultimo?.fin
        ? [a.ultimo]
        : []) {
      if (j.jobId)
        jobs.set(j.jobId, { ...jobs.get(j.jobId), ...j, agente: a.id });
    }
  return [...jobs.values()].sort((a, b) =>
    String(b.fin).localeCompare(String(a.fin)),
  );
}

export function agentsForProject(
  agents: TeamAgent[],
  flows: TeamFlow[],
  project: string,
) {
  return [
    ...new Set([
      ...agents
        .filter(
          (a) =>
            a.ultimo?.project === project ||
            a.historial?.some((j) => j.project === project),
        )
        .map((a) => a.id),
      ...flows
        .filter((f) => f.project === project)
        .flatMap((f) => f.pasos.map((s) => s.agente)),
    ]),
  ];
}

/** One read model for the world and React: the launcher's sessions. */
export function createTeamController(api: TeamTransport) {
  let snapshot: TeamSnapshot = {
    agents: [],
    flows: [],
    events: [],
    connected: false,
    loaded: false,
    error: "",
    pending: [],
    sessions: null,
  };
  const listeners = new Set<() => void>();
  let reading: Promise<void> | null = null;
  const publish = (patch: Partial<TeamSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const refresh = () => {
    if (reading) return reading;
    reading = (async () => {
      try {
        // Polled all the time: the scene never needs the transcripts.
        const sessions = await api("/agentes/sesiones?resumen=1");
        if (!Array.isArray(sessions))
          throw new Error("El lanzador no respondió.");
        publish({
          agents: sesionesEscena(sessions as SesionObservada[]).base.map(
            (a) => ({
              id: a.id,
              ocupada: !!a.ocupada,
              ultimo: a.ultimo as TeamJob | null,
            }),
          ),
          sessions: sessions as SesionObservada[],
          connected: true,
          loaded: true,
          error: "",
        });
      } catch (error) {
        publish({
          connected: false,
          loaded: true,
          error:
            error instanceof Error
              ? error.message
              : "No se pudo actualizar el equipo.",
        });
      } finally {
        reading = null;
      }
    })();
    return reading;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
  };
}
export type TeamController = ReturnType<typeof createTeamController>;
