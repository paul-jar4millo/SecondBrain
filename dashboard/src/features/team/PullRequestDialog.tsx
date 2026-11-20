import { useEffect, useId, useState } from "react";
import { GitPullRequest, Sparkles } from "lucide-react";
import { teamApi } from "./team-store";
import type { Capabilities } from "./harness-changes";

const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w./-]+\))?!?: \S.*$/;
const PR_TIMEOUT = 240_000;

interface Proposal {
  titulo: string;
  descripcion: string;
}
interface Created {
  rama: string;
  commit: string;
  url: string;
  existente?: boolean;
}

/**
 * Editable pull request form: starts from the launcher's deterministic proposal
 * and only asks the agent to draft it when the user presses the button.
 */
export function PullRequestDialog({
  id,
  agentName,
  capacidades: capabilities,
  onClose,
  onCreated,
}: {
  id: string;
  agentName: string;
  capacidades?: Capabilities;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    let live = true;
    teamApi(`/agentes/sesiones/pr/propuesta?id=${id}`)
      .then((p) => {
        if (!live) return;
        const proposal = p as Proposal;
        setTitle(proposal.titulo);
        setBody(proposal.descripcion);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id]);

  const valid = CONVENTIONAL.test(title.trim()) && title.trim().length <= 200;
  const redactable = capabilities?.redactarPr !== false;

  const draftWithAgent = async () => {
    setDrafting(true);
    setError("");
    setNote("");
    try {
      const r = (await teamApi(
        "/agentes/sesiones/pr/redactar",
        { id },
        180_000,
      )) as Proposal;
      setTitle(r.titulo);
      setBody(r.descripcion);
      setNote(`Texto redactado por ${agentName}. Revísalo antes de crear.`);
    } catch (e) {
      // The deterministic proposal stays in the fields.
      setNote("");
      setError(
        `${(e as Error).message || "No se pudo redactar."} Se conserva la propuesta.`,
      );
    } finally {
      setDrafting(false);
    }
  };

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const r = (await teamApi(
        "/agentes/sesiones/pr",
        { id, titulo: title.trim(), descripcion: body, borrador: draft },
        PR_TIMEOUT,
      )) as Created;
      setCreated(r);
      onCreated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section
      className="pr-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${uid}-title`}
    >
      <h3 id={`${uid}-title`}>
        <GitPullRequest size={16} aria-hidden="true" /> Crear pull request
      </h3>
      {created ? (
        <div role="status" className="pr-result">
          <p>
            {created.existente
              ? "Ya había un PR abierto para esta rama."
              : "Pull request creado."}{" "}
            Rama <code>{created.rama}</code>.
          </p>
          <p>
            <a href={created.url} target="_blank" rel="noopener noreferrer">
              Abrir el PR en GitHub
            </a>
          </p>
          <button type="button" className="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !creating && !loading && !drafting) void create();
          }}
        >
          <label htmlFor={`${uid}-t`}>Título (Conventional Commits)</label>
          <input
            id={`${uid}-t`}
            value={title}
            maxLength={200}
            disabled={loading || creating || drafting}
            aria-invalid={!valid && !loading}
            onChange={(e) => setTitle(e.target.value)}
          />
          {!valid && !loading && (
            <small className="muted">
              Usa el formato «tipo(ámbito): resumen», por ejemplo «feat: añade
              X».
            </small>
          )}
          <label htmlFor={`${uid}-d`}>Descripción</label>
          <textarea
            id={`${uid}-d`}
            rows={9}
            value={body}
            maxLength={20000}
            disabled={loading || creating || drafting}
            onChange={(e) => setBody(e.target.value)}
          />
          <label className="pr-draft">
            <input
              type="checkbox"
              checked={draft}
              disabled={loading || creating || drafting}
              onChange={(e) => setDraft(e.target.checked)}
            />
            Borrador
          </label>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="pr-actions">
            <button
              type="submit"
              className="button primary"
              disabled={!valid || creating || loading || drafting}
            >
              <GitPullRequest size={14} aria-hidden="true" />
              {creating ? "Creando…" : "Crear PR"}
            </button>
            <button
              type="button"
              className="button"
              disabled={!redactable || drafting || creating || loading}
              title={
                redactable
                  ? `${agentName} redacta el título y la descripción con una ejecución corta; consume cuota.`
                  : "Este agente no puede redactar el PR en esta sesión."
              }
              onClick={() => void draftWithAgent()}
            >
              <Sparkles size={14} aria-hidden="true" />
              {drafting ? "Redactando…" : `Redactar con ${agentName}`}
            </button>
            <button type="button" className="button subtle" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
