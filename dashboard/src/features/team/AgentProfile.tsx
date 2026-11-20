import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy } from "lucide-react";
import { useUI } from "../../components/ui";
import { projectPrompt, taskPrompt } from "../../core/agent-prompt";
import { today } from "../../core/model";
import { workspacesOf } from "../room/room-workspaces";
import { character } from "./characters";
import { type AgentTarget } from "./team-controller";
import { useTeam } from "./team-store";
import { AgentPortrait, agentStatus, StatusTag } from "./TeamPrimitives";

const motorDe: Record<string, string> = {
  ambar: "claude",
  menta: "codex",
  lira: "agy",
  marina: "deepseek",
};

/** Agent card: active launcher sessions and a prompt to paste into a harness. */
export function AgentProfile({
  target,
  onClose,
}: {
  target: AgentTarget;
  onClose: () => void;
}) {
  const { items, notify, openTeam } = useUI();
  const state = useTeam();
  const a = character(target.agentId);
  const live = state.agents.find((x) => x.id === target.agentId);
  const [project, setProject] = useState(target.projectId || "general");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const spaces = workspacesOf(items);
  if (!spaces.some((p) => p.id === project))
    spaces.push({ id: project, titulo: "Proyecto no disponible", detalle: "" });
  if (!a)
    return (
      <aside className="agent-inspector">
        <button className="button" onClick={onClose}>
          Volver
        </button>
        <p>Esta agente no está disponible.</p>
      </aside>
    );
  const sesiones = (state.sessions || []).filter(
    (s) =>
      s.motor === motorDe[a.id] &&
      ["pendiente", "trabajando"].includes(s.estado),
  );
  const prompt = () => {
    const task = items.find((i) => i.id === target.taskId);
    const p = items.find((i) => i.id === project && i.kind === "project");
    return task
      ? taskPrompt(task, items)
      : p
        ? projectPrompt(p, items, today())
        : "";
  };
  return (
    <aside className="agent-inspector" aria-label={`Ficha de ${a.name}`}>
      <button className="inspector-back" onClick={onClose}>
        <ArrowLeft size={16} aria-hidden="true" /> Volver
      </button>
      <div className="agent-profile-hero">
        <AgentPortrait id={a.id} size="large" />
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {a.name}
          </h2>
          <span>
            {a.provider} · {a.id === "marina" ? "API" : "Suscripción"}
          </span>
        </div>
      </div>
      <StatusTag state={live?.ocupada ? "trabajando" : undefined}>
        {agentStatus(live)}
      </StatusTag>
      <section className="profile-current">
        <h3>Sesiones activas</h3>
        {sesiones.length ? (
          <ul>
            {sesiones.map((s) => (
              <li key={s.id}>
                {s.proyecto || "Sin proyecto"} ·{" "}
                {s.ultimaAccion || "Trabajando"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Sin sesiones en curso.</p>
        )}
        <button className="button" onClick={() => openTeam({ tab: "vivo" })}>
          Encargar desde Equipo
        </button>
      </section>
      <section className="profile-handoff">
        <h3>Encargo para pegar en tu harness</h3>
        <label htmlFor="agent-profile-project">
          Proyecto
          <select
            id="agent-profile-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            {spaces.map((p) => (
              <option key={p.id} value={p.id}>
                {p.titulo}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={!prompt()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(prompt());
              notify("Encargo copiado.");
            } catch {
              notify("No se pudo copiar el encargo.");
            }
          }}
        >
          <Copy size={16} aria-hidden="true" /> Copiar encargo
        </button>
      </section>
    </aside>
  );
}
