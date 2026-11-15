import { useEffect, useState } from "react";
import { teamApi } from "./team-store";
import { isDemo } from "../../core/store";
export interface ProjectLinks {
  revision: number;
  repositorios: string[];
  vinculos: Record<string, string | null>;
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
      void teamApi("/agentes/espacios")
        .then((result) => {
          if (live) {
            setLinks(result as ProjectLinks);
            setError("");
          }
        })
        .catch(() => {
          if (live) setError("No se pudieron consultar los repositorios.");
        });
    return () => {
      live = false;
    };
  }, [projectId]);
  return (
    <div className="project-repository">
      <label>
        Repositorio del proyecto
        <select
          value={links?.vinculos[projectId] || ""}
          disabled={!links || busy}
          onChange={async (event) => {
            const repositorio = event.target.value || null;
            setBusy(true);
            setError("");
            try {
              const next = (await teamApi("/agentes/espacios", {
                id: projectId,
                repositorio,
                revision: links!.revision,
              })) as ProjectLinks;
              setLinks(next);
              onChange?.(next);
            } catch (e) {
              setError((e as Error).message);
              const next = await teamApi("/agentes/espacios").catch(() => null);
              if (next) setLinks(next as ProjectLinks);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Sin repositorio · espacio propio</option>
          {links?.repositorios.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      <small>
        Carpetas descargadas en el servidor. El vínculo se aplica a las
        conversaciones nuevas.
      </small>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
