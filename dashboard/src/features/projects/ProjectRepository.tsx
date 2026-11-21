import { useEffect, useState } from "react";
import { agentApi } from "../agents/agent-api";
import { isDemo } from "../../core/store";
export interface ProjectLinks {
  revision: number;
  repositories: string[];
  repositoryPaths?: Record<string, string>;
  links: Record<string, string | null>;
}
export function ProjectRepository({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange?: (links: ProjectLinks) => void;
}) {
  const [links, setLinks] = useState<ProjectLinks | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (!isDemo)
      void agentApi("/agents/workspaces")
        .then((result) => {
          if (live) {
            setLinks(result as ProjectLinks);
            onChange?.(result as ProjectLinks);
            setError("");
          }
        })
        .catch(() => {
          if (live) setError("No se pudieron consultar los repositorios.");
        });
    return () => {
      live = false;
    };
  }, [projectId, onChange]);
  return (
    <div className="project-repository">
      <label>
        Repositorio del proyecto
        <select
          value={links?.links[projectId] || ""}
          disabled={!links || busy}
          onChange={async (event) => {
            const repository = event.target.value || null;
            setBusy(true);
            setError("");
            try {
              const next = (await agentApi("/agents/workspaces", {
                id: projectId,
                repository,
                revision: links!.revision,
              })) as ProjectLinks;
              setLinks(next);
              onChange?.(next);
            } catch (e) {
              setError((e as Error).message);
              const next = await agentApi("/agents/workspaces").catch(
                () => null,
              );
              if (next) {
                setLinks(next as ProjectLinks);
                onChange?.(next as ProjectLinks);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Sin repositorio · espacio propio</option>
          {links?.repositories.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      <small>
        Carpetas descargadas en el servidor. El vínculo se aplica a las threads
        nuevos.
      </small>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
