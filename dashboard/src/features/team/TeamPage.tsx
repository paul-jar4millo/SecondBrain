import { PageHeading } from "../../components/PageHeading";
import { teamController, useTeam } from "./team-store";
import { ApprovalPanel } from "./ApprovalPanel";
import { AgentWorkspace } from "./AgentWorkspace";

export function TeamPage() {
  const team = useTeam();
  return (
    <>
      <PageHeading title="Equipo" />
      <ApprovalPanel hideEmpty />
      {!team.loaded ? (
        <div className="team-skeleton" role="status">
          Conectando con el equipo…
        </div>
      ) : (
        (!team.connected || team.error) && (
          <p className="inline-error" role="status">
            {team.error || "Lanzador sin conectar."} Las últimas sesiones se
            conservan.
          </p>
        )
      )}
      <AgentWorkspace onRefresh={() => void teamController.refresh()} />
    </>
  );
}
