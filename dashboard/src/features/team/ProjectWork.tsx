import { useUI } from "../../components/ui";
import { useTeam } from "./team-store";
import { character } from "./characters";
import { StatusTag } from "./TeamPrimitives";

const personaje: Record<string, string> = {
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
};

/** Sessions running for this project; silent when there are none. */
export function ProjectWork({ projectId }: { projectId: string }) {
  const team = useTeam();
  const { openAgent } = useUI();
  const activas = (team.sessions || []).filter(
    (s) =>
      (s.espacioId || s.proyecto) === projectId &&
      ["pendiente", "trabajando"].includes(s.estado),
  );
  if (!activas.length) return null;
  return (
    <div className="project-work">
      <h3>En curso</h3>
      {activas.map((s) => (
        <button
          className="history-link"
          key={s.id}
          onClick={() =>
            openAgent({
              agentId: personaje[s.motor] || s.motor,
              projectId,
              chatId: s.id,
            })
          }
        >
          <span>
            {character(personaje[s.motor])?.name} ·{" "}
            {s.ultimaAccion || "Sesión en curso"}
          </span>
          <StatusTag state="trabajando" />
        </button>
      ))}
    </div>
  );
}
