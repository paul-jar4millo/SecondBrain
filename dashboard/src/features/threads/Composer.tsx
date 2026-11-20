import { useEffect, useState } from "react";
import {
  ModelEffortPicker,
  choicePayload,
  loadChoice,
  saveChoice,
  type Model,
  type ModelChoice,
} from "../agents/ModelEffortPicker";
import { UsageBars } from "../agents/UsageBars";
import { agentName, characters } from "../agents/characters";
import { isDemo } from "../../core/store";
import { threadsApi } from "./thread-api";
import type { ThreadView } from "./thread-store";
import type { AgentRef, Engine } from "./thread-types";

const ENGINES = characters.map((agent) => agent.engine);

let catalog: Promise<Record<string, Model[]>> | null = null;
/** The launcher's model list, loaded once per page. */
export function useModels() {
  const [models, setModels] = useState<Record<string, Model[]>>({});
  useEffect(() => {
    if (isDemo) return;
    let alive = true;
    catalog ??= threadsApi.models().catch(() => {
      catalog = null;
      return {};
    });
    void catalog.then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, []);
  return models;
}

/** Engine plus model and effort, remembered per engine on this device. */
export function AgentPicker({
  engine,
  onEngine,
  choice,
  onChoice,
  models,
}: {
  engine: Engine;
  onEngine: (engine: Engine) => void;
  choice: ModelChoice;
  onChoice: (choice: ModelChoice) => void;
  models: Record<string, Model[]>;
}) {
  return (
    <div className="thread-agent-picker">
      <label>
        Agente
        <select
          aria-label="Agente"
          value={engine}
          onChange={(e) => onEngine(e.target.value as Engine)}
        >
          {ENGINES.map((e) => (
            <option key={e} value={e}>
              {agentName(e)} ({e})
            </option>
          ))}
        </select>
      </label>
      <ModelEffortPicker
        models={models[engine] ?? []}
        choice={choice}
        onChange={(next) => {
          onChoice(next);
          saveChoice(engine, next);
        }}
      />
    </div>
  );
}

export function agentRef(
  engine: Engine,
  models: Record<string, Model[]>,
  choice: ModelChoice,
): AgentRef {
  const picked = choicePayload(models[engine] ?? [], choice);
  return {
    engine,
    ...(picked.modelo ? { model: picked.modelo } : {}),
    ...(picked.esfuerzo ? { effort: picked.esfuerzo } : {}),
  } as AgentRef;
}

export function Composer({
  view,
  onSent,
}: {
  view: ThreadView;
  onSent: () => void;
}) {
  const { thread } = view;
  const models = useModels();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAgent, setShowAgent] = useState(false);
  const [engine, setEngine] = useState<Engine>(thread.agent.engine as Engine);
  const [choice, setChoice] = useState<ModelChoice>(() =>
    loadChoice(thread.agent.engine),
  );
  const closed = ["closing", "done", "failed", "archived"].includes(
    thread.status,
  );
  const working = view.activeTurn !== null || thread.status === "running";

  const send = async (mode: "send" | "steer" | "queue") => {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const agent = showAgent ? agentRef(engine, models, choice) : undefined;
      await threadsApi.send(thread.id, value, mode, agent);
      setText("");
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (closed)
    return (
      <p className="thread-composer-closed muted">Este thread está cerrado.</p>
    );
  return (
    <form
      className="thread-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send(working ? "queue" : "send");
      }}
    >
      {showAgent && (
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
      {!isDemo && (
        <UsageBars motor={showAgent ? engine : thread.agent.engine} />
      )}
      <textarea
        aria-label="Mensaje"
        rows={3}
        placeholder={
          working
            ? "Redirige al agente o deja un mensaje en cola…"
            : "Escribe al agente…"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(working ? "steer" : "send");
          }
        }}
      />
      <div className="thread-composer-actions">
        <button
          type="button"
          className="button subtle"
          aria-pressed={showAgent}
          onClick={() => setShowAgent(!showAgent)}
        >
          {showAgent
            ? "Mismo agente"
            : `Agente: ${agentName(thread.agent.engine)}`}
        </button>
        <span className="spacer" />
        {working && (
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() =>
              void threadsApi
                .interrupt(thread.id)
                .then(onSent)
                .catch((e: Error) => setError(e.message))
            }
          >
            Detener
          </button>
        )}
        {working ? (
          <>
            <button
              type="button"
              className="button"
              disabled={busy || !text.trim()}
              title="Entra en el turno actual (Ctrl+Enter)"
              onClick={() => void send("steer")}
            >
              Redirigir
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !text.trim()}
            >
              En cola
            </button>
          </>
        ) : (
          <button
            type="submit"
            className="button primary"
            disabled={busy || !text.trim()}
          >
            Enviar
          </button>
        )}
      </div>
      {error && <p className="inline-error">{error}</p>}
    </form>
  );
}
