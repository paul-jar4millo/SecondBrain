import { type CSSProperties, useState } from "react";
import { character, characters, teamStates } from "./characters";
import type { TeamAgent, TeamFlow } from "./team-controller";
import { useUI } from "../../components/ui";
import { useTeam } from "./team-store";
import { agentsForProject } from "./team-controller";

export function AgentPortrait({
  id,
  size = "small",
}: {
  id: string;
  size?: "small" | "medium" | "large";
}) {
  const a = character(id);
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`agent-portrait portrait-${size}`}
      style={{ "--portrait-color": a?.color || "#7c8cff" } as CSSProperties}
      aria-hidden="true"
    >
      {failed ? (
        <span>{a?.name[0] || "?"}</span>
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}portraits/${id}.png`}
          width="320"
          height="320"
          alt=""
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function agentStatus(agent?: TeamAgent, flows: TeamFlow[] = []) {
  if (!agent) return "Sin lectura";
  if (agent.ocupada) return agent.ultimo?.actividad?.etiqueta || "Trabajando";
  const waiting = flows.find(
    (f) =>
      ["esperando", "en-cola"].includes(f.estado) &&
      f.pasos[f.indice]?.agente === agent.id,
  );
  return waiting
    ? teamStates[waiting.estado]
    : ["error", "interrumpido"].includes(agent.ultimo?.estado || "")
      ? "Necesita atención"
      : "Disponible";
}

export function StatusTag({
  state,
  children,
}: {
  state?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="work-status" data-state={state || "available"}>
      {children || teamStates[state || ""] || state}
    </span>
  );
}

export function ProjectAgents({ projectId }: { projectId: string }) {
  const { openAgent } = useUI();
  const team = useTeam();
  const related = agentsForProject(team.agents, team.flows, projectId);
  return (
    <div className="project-agents">
      <div
        className="portrait-row"
        role="group"
        aria-label="Consultar agentes para este proyecto"
      >
        {characters.map((a) => (
          <button
            key={a.id}
            type="button"
            className="portrait-button"
            aria-label={`Consultar a ${a.name} para este proyecto`}
            title={`${a.name} · ${agentStatus(
              team.agents.find((x) => x.id === a.id),
              team.flows,
            )}`}
            onClick={() => openAgent({ agentId: a.id, projectId })}
          >
            <AgentPortrait id={a.id} />
            {related.includes(a.id) && (
              <i
                className="recorded-work"
                aria-label="Con trabajo registrado"
              />
            )}
          </button>
        ))}
      </div>
      <span>
        {related.length
          ? `${related.length} con trabajo registrado`
          : "Consulta al equipo"}
      </span>
    </div>
  );
}

export function jobDate(value?: string) {
  return value
    ? new Date(value).toLocaleString("es-MX", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
export function jobDuration(job?: { inicio?: string; fin?: string } | null) {
  if (!job?.inicio) return "";
  const seconds = Math.max(
    0,
    Math.floor(
      ((job.fin ? Date.parse(job.fin) : Date.now()) - Date.parse(job.inicio)) /
        1000,
    ),
  );
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
