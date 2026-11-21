import "./threads.css";
import { useEffect, useState } from "react";
import { character } from "../agents/characters";
import { preference } from "../settings/preferences";
import { agentApi } from "../agents/agent-api";
import type { ProjectLinks } from "../projects/ProjectRepository";
import { isDemo } from "../../core/store";
import { Modal } from "../../components/ui";
import { loadChoice, type ModelChoice } from "../agents/ModelEffortPicker";
import { AgentPicker, agentRef, useModels } from "./Composer";
import { threadsApi } from "./thread-api";
import type { AgentRef, Engine, FlowTemplate, Thread } from "./thread-types";

interface StagePick {
  engine: Engine;
  choice: ModelChoice;
}

const AUTONOMY: { id: Thread["autonomy"]; label: string; hint: string }[] = [
  {
    id: "auto-worktree",
    label: "Autónomo en su rama",
    hint: "Ejecuta y edita sin preguntar dentro de su worktree.",
  },
  {
    id: "ask",
    label: "Preguntar antes",
    hint: "Pide aprobación para comandos y ediciones.",
  },
  {
    id: "read-only",
    label: "Solo lectura",
    hint: "Lee y analiza; no escribe.",
  },
];

export function NewThreadDialog({
  onClose,
  onCreated,
  initialPrompt = "",
  initialEngine,
  projectId,
}: {
  onClose: () => void;
  onCreated: (thread: Thread) => void;
  initialPrompt?: string;
  initialEngine?: Engine;
  projectId?: string;
}) {
  const models = useModels();
  const [projects, setProjects] = useState<string[]>([]);
  const [engine, setEngine] = useState<Engine>(
    () =>
      initialEngine ??
      character(preference("defaultAgent"))?.engine ??
      "claude",
  );
  const [draftKey] = useState(
    () => "sb-chat-draft:" + (projectId || "general") + ":" + engine,
  );
  const [savedDraft] = useState(() => {
    if (isDemo) return "";
    try {
      return localStorage.getItem(draftKey)?.trim() ?? "";
    } catch {
      return "";
    }
  });
  const [prompt, setPrompt] = useState(() => {
    if (!savedDraft) return initialPrompt;
    if (!initialPrompt || savedDraft.includes(initialPrompt.trim()))
      return savedDraft;
    return savedDraft + "\n\n" + initialPrompt.trim();
  });
  const [project, setProject] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(!isDemo);
  const [autonomy, setAutonomy] = useState<Thread["autonomy"]>("auto-worktree");
  const [choice, setChoice] = useState<ModelChoice>(() => loadChoice(engine));
  const [flows, setFlows] = useState<FlowTemplate[]>([]);
  const [flowId, setFlowId] = useState("single");
  const [stagePicks, setStagePicks] = useState<Record<string, StagePick>>({});
  const flow = flows.find((f) => f.id === flowId);
  const staged = (flow?.stages.length ?? 0) > 1;
  useEffect(() => {
    if (isDemo) return;
    let active = true;
    void threadsApi
      .flows()
      .then(({ flows }) => active && setFlows(flows))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const pickOf = (key: string): StagePick =>
    stagePicks[key] ?? { engine, choice };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (isDemo) return;
    let active = true;
    void Promise.all([
      threadsApi.projects().catch((): string[] => []),
      projectId
        ? agentApi("/agents/workspaces")
            .then((result) => result as ProjectLinks)
            .catch(() => null)
        : null,
    ]).then(([list, links]) => {
      if (!active) return;
      const linked = projectId ? links?.links[projectId] : null;
      setProjects(list);
      setProject(linked && list.includes(linked) ? linked : "");
      setLoadingProjects(false);
    });
    return () => {
      active = false;
    };
  }, [projectId]);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const stageAgents: Record<string, AgentRef> = {};
      if (flow && staged)
        for (const stage of flow.stages) {
          const pick = pickOf(stage.key);
          stageAgents[stage.key] = agentRef(pick.engine, models, pick.choice);
        }
      const { thread } = await threadsApi.create({
        prompt: prompt.trim(),
        kind: project ? "repo" : "scratch",
        ...(project ? { repoPath: project } : {}),
        agent: agentRef(engine, models, choice),
        autonomy,
        ...(flow ? { flowTemplateId: flow.id } : {}),
        ...(staged ? { stageAgents } : {}),
      });
      try {
        if (savedDraft && localStorage.getItem(draftKey)?.trim() === savedDraft)
          localStorage.removeItem(draftKey);
      } catch {
        // Storage can be unavailable in private browsing.
      }
      onCreated(thread);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Nuevo thread"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        className="thread-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim() && !busy && !loadingProjects && !isDemo)
            void create();
        }}
      >
        <label>
          Tarea
          <textarea
            required
            rows={5}
            autoFocus
            value={prompt}
            placeholder="Qué debe hacer el agente…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          Proyecto
          <select
            aria-label="Proyecto"
            value={project}
            disabled={loadingProjects || busy}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">Sin repositorio (carpeta temporal)</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {flows.length > 1 && (
          <label>
            Flujo
            <select
              aria-label="Flujo"
              value={flowId}
              disabled={busy}
              onChange={(e) => setFlowId(e.target.value)}
            >
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {flow && <small>{flow.description}</small>}
          </label>
        )}
        {flow && staged ? (
          <fieldset className="thread-stages">
            <legend>Agente por etapa</legend>
            {flow.stages.map((stage, index) => {
              const pick = pickOf(stage.key);
              const update = (next: StagePick) =>
                setStagePicks({ ...stagePicks, [stage.key]: next });
              return (
                <AgentPicker
                  key={stage.key}
                  label={`${index + 1}. ${stage.name}${stage.readOnly ? " (solo lectura)" : ""}`}
                  engine={pick.engine}
                  onEngine={(e) => update({ engine: e, choice: loadChoice(e) })}
                  choice={pick.choice}
                  onChoice={(c) => update({ ...pick, choice: c })}
                  models={models}
                />
              );
            })}
          </fieldset>
        ) : (
          <AgentPicker
            engine={engine}
            onEngine={(e) => {
              setEngine(e);
              setChoice(loadChoice(e));
            }}
            choice={choice}
            onChoice={setChoice}
            models={models}
          />
        )}
        <fieldset className="thread-autonomy">
          <legend>Autonomía</legend>
          {AUTONOMY.map((a) => (
            <label key={a.id}>
              <input
                type="radio"
                name="autonomy"
                checked={autonomy === a.id}
                onChange={() => setAutonomy(a.id)}
              />
              <span>
                {a.label}
                <small>{a.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {error && <p className="inline-error">{error}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || loadingProjects || isDemo || !prompt.trim()}
          >
            {busy ? "Creando…" : "Crear thread"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CloseDialog({
  thread,
  onClose,
  onDone,
}: {
  thread: Thread;
  onClose: () => void;
  onDone: () => void;
}) {
  const repo = Boolean(thread.repo);
  const [mode, setMode] = useState<"pr" | "merge" | "discard">(
    repo ? "pr" : "discard",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await threadsApi.close(thread.id, mode, title.trim(), body.trim());
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Cerrar thread" onClose={onClose}>
      <form
        className="thread-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="thread-autonomy">
          <legend>Cómo cerrar</legend>
          {repo && (
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "pr"}
                onChange={() => setMode("pr")}
              />
              <span>
                Abrir un PR
                <small>
                  Sube {thread.repo?.branch} y abre el PR contra{" "}
                  {thread.repo?.baseBranch}.
                </small>
              </span>
            </label>
          )}
          {repo && (
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "merge"}
                onChange={() => setMode("merge")}
              />
              <span>
                Integrar en local
                <small>
                  Une la rama en {thread.repo?.baseBranch}; si hay conflictos no
                  cambia nada.
                </small>
              </span>
            </label>
          )}
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "discard"}
              onChange={() => setMode("discard")}
            />
            <span>
              Descartar
              <small>Borra el trabajo del thread.</small>
            </span>
          </label>
        </fieldset>
        {mode !== "discard" && (
          <label>
            Título del commit
            <input
              value={title}
              placeholder={`feat: ${thread.title}`}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        {mode === "pr" && (
          <label>
            Descripción del PR
            <textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        )}
        {error && <p className="inline-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className={mode === "discard" ? "button danger" : "button primary"}
            disabled={busy}
          >
            {busy
              ? "Cerrando…"
              : mode === "pr"
                ? "Abrir PR"
                : mode === "merge"
                  ? "Integrar"
                  : "Descartar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
