import { useEffect, useState } from "react";
import { Modal } from "../../components/ui";
import { loadChoice, type ModelChoice } from "../team/ModelEffortPicker";
import { AgentPicker, agentRef, useModels } from "./Composer";
import { threadsApi } from "./thread-api";
import type { Engine, Thread } from "./thread-types";

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
  initialProject = "",
}: {
  onClose: () => void;
  onCreated: (thread: Thread) => void;
  initialPrompt?: string;
  initialProject?: string;
}) {
  const models = useModels();
  const [projects, setProjects] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [project, setProject] = useState(initialProject);
  const [autonomy, setAutonomy] = useState<Thread["autonomy"]>("auto-worktree");
  const [engine, setEngine] = useState<Engine>("claude");
  const [choice, setChoice] = useState<ModelChoice>(() => loadChoice("claude"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    threadsApi
      .projects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const { thread } = await threadsApi.create({
        prompt: prompt.trim(),
        kind: project ? "repo" : "scratch",
        ...(project ? { repoPath: project } : {}),
        agent: agentRef(engine, models, choice),
        autonomy,
      });
      onCreated(thread);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Nuevo thread" onClose={onClose} wide>
      <form
        className="thread-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim()) void create();
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
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Sin repositorio (carpeta temporal)</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
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
          <button type="button" className="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !prompt.trim()}
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
