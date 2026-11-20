import { type CSSProperties, useState } from "react";
import { character, characters, teamStates } from "./characters";
import { useUI } from "../../components/ui";

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
  const { openThread } = useUI();
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
            title={a.name}
            onClick={() => openThread({ engine: a.engine, projectId })}
          >
            <AgentPortrait id={a.id} />
          </button>
        ))}
      </div>
    </div>
  );
}
