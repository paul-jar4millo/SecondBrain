import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Paperclip, RefreshCw, Square, Trash2 } from "lucide-react";
import { useUI } from "../../components/ui";
import { isDemo } from "../../core/store";
import { subscribeChanges } from "../../core/events";
import { workspacesOf } from "../room/room-workspaces";
import { characters } from "./characters";
import { AgentPortrait } from "./TeamPrimitives";
import { teamApi, useTeam } from "./team-store";
import { agentStatus } from "./TeamPrimitives";
import { ProviderConversation } from "./ProviderConversation";
import { HarnessChanges } from "./HarnessChanges";
import { ProjectRepository, type ProjectLinks } from "./ProjectRepository";
import { Markdown } from "../../components/Markdown";
import { draftKey as draftKeyFor, engines } from "./agent-draft";
import { preference } from "../settings/preferences";
import { fileReference, filesMessage, uploadForAgents } from "../files/upload";
import { throttled } from "../../core/throttle";
import {
  choicePayload,
  loadChoice,
  ModelEffortPicker,
  saveChoice,
  type Model,
} from "./ModelEffortPicker";
import { UsageBars } from "./UsageBars";
import type { Capabilities, Checkpoint } from "./harness-changes";

// The event stream announces changes; the timer only covers a lost connection.
const REFRESH_EVERY = 20_000;
const REFRESH_AT_MOST_EVERY = 4_000;
const agentTone = (status: string) =>
  status === "Disponible"
    ? "ok"
    : status === "Necesita atención"
      ? "alert"
      : status === "Sin lectura"
        ? "idle"
        : "busy";
interface Conversation {
  id: string;
  motor: string;
  proyecto?: string;
  espacioId?: string;
  harness?: boolean;
  structured?: boolean;
  interactiva?: boolean;
  estado: string;
  encargo?: string;
  creada?: string;
  resultado?: string;
  error?: string;
  conversacionId?: string;
  remotoUrl?: string;
  mensajes?: { rol: string; texto: string }[];
  contexto?: { usados: number; limite: number };
  capacidades?: Capabilities | null;
  checkpoints?: Checkpoint[];
}
function remember(key: string, value?: string) {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function AgentWorkspace({ onRefresh }: { onRefresh?: () => void }) {
  const { items } = useUI();
  const team = useTeam();
  const [params, setParams] = useSearchParams();
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const routeChat = params.get("chat") || params.get("job");
  const routeSession =
    routeChat && routeChat !== "new"
      ? sessions.find((s) => s.id === routeChat)
      : undefined;
  const spaces = workspacesOf(items);
  const requested =
    params.get("project") ||
    routeSession?.espacioId ||
    remember("sb-team-project") ||
    "general";
  const project = spaces.some((p) => p.id === requested)
    ? requested
    : "general";
  const routeAgent = routeSession
    ? Object.entries(engines).find(([, m]) => m === routeSession.motor)?.[0]
    : undefined;
  const agent =
    characters.find(
      (a) =>
        a.id ===
        (params.get("agent") ||
          routeAgent ||
          remember(`sb-team-agent:${project}`) ||
          preference("defaultAgent")),
    ) || characters[0];
  const engine = engines[agent.id];
  const [links, setLinks] = useState<ProjectLinks | null>(null);
  const [catalog, setCatalog] = useState<Record<string, Model[]>>({});
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [choice, setChoice] = useState(() => loadChoice(engine));
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const draftKey = draftKeyFor(project, engine);
  const [draft, setDraft] = useState(() => remember(draftKey));
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const draftCursor = useRef<number | null>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const focusDraft = useRef(false);
  const view = useRef("");
  view.current = `${project}:${engine}:${routeChat || ""}`;
  const refreshRevision = useRef(0);
  // Only a conversation without terminal shows its transcript.
  const needsTranscript = useRef(false);
  const offline = useRef(false);
  const setRoute = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    if ("chat" in patch) next.delete("job");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };
  const refresh = useCallback(async () => {
    if (isDemo) return;
    const current = ++refreshRevision.current;
    try {
      const [list, bindings] = await Promise.all([
        teamApi(
          needsTranscript.current
            ? "/agentes/sesiones"
            : "/agentes/sesiones?resumen=1",
        ),
        teamApi("/agentes/espacios"),
      ]);
      if (current !== refreshRevision.current) return;
      setSessions(list as Conversation[]);
      setLinks(bindings as ProjectLinks);
      offline.current = false;
      setConnected(true);
      setConnectionError("");
    } catch {
      if (current !== refreshRevision.current) return;
      offline.current = true;
      setConnected(false);
      setConnectionError(
        "No se pudo conectar con el lanzador. Tus conversaciones siguen guardadas.",
      );
    }
  }, []);
  useEffect(() => {
    let live = true;
    const revision = refreshRevision;
    const paced = throttled(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_AT_MOST_EVERY);
    // Back from a lost connection there is nothing to pace: show it at once.
    const update = () => {
      if (offline.current) void refresh();
      else paced();
    };
    paced();
    const unsubscribe = subscribeChanges(update);
    const tick = setInterval(update, REFRESH_EVERY);
    document.addEventListener("visibilitychange", update);
    void teamApi("/agentes/modelos-lanzador")
      .then((c) => {
        if (live) setCatalog(c as Record<string, Model[]>);
      })
      .catch(() => {});
    return () => {
      live = false;
      revision.current++;
      view.current = "";
      unsubscribe();
      clearInterval(tick);
      paced.cancel();
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
  useLayoutEffect(() => {
    const pos = draftCursor.current;
    if (pos === null || !draftRef.current) return;
    draftCursor.current = null;
    draftRef.current.setSelectionRange?.(pos, pos);
  }, [draft]);
  useEffect(() => {
    setDraft(remember(draftKey));
    setChoice(loadChoice(engine));
  }, [draftKey, engine]);
  useEffect(() => {
    remember("sb-team-project", project);
  }, [project]);
  useEffect(() => {
    remember(`sb-team-agent:${project}`, agent.id);
  }, [project, agent.id]);
  const repo = links?.vinculos[project];
  const conversations = sessions
    .filter(
      (s) =>
        s.motor === engine &&
        (s.espacioId
          ? s.espacioId === project
          : repo
            ? s.proyecto === repo
            : project === "general" &&
              (!s.proyecto || s.proyecto === "general")),
    )
    .sort((a, b) => (b.creada || "").localeCompare(a.creada || ""));
  const selectedId =
    routeChat || remember(`sb-chat-selected:${project}:${engine}`);
  const selected =
    selectedId === "new"
      ? undefined
      : conversations.find((s) => s.id === selectedId) || conversations[0];
  const showsTranscript = !!selected && !selected.structured;
  needsTranscript.current = showsTranscript;
  useEffect(() => {
    if (showsTranscript) void refresh();
  }, [showsTranscript, selected?.id, refresh]);
  useEffect(() => {
    if (focusDraft.current && draftRef.current) {
      focusDraft.current = false;
      draftRef.current.focus();
      draftRef.current.scrollIntoView?.({ block: "nearest" });
    }
  });
  const active =
    selected &&
    (selected.interactiva ||
      ["pendiente", "trabajando"].includes(selected.estado));
  const models = catalog[engine] || [];
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Files go to the Maletín; the message names them so the agent can fetch them.
  const attach = async (files: File[]) => {
    if (!files.length || isDemo) return;
    const key = draftKey;
    setUploading(true);
    setError("");
    const uploaded: string[] = [];
    try {
      for (const file of files)
        uploaded.push(fileReference(await uploadForAgents(file)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
    if (!uploaded.length) return;
    const next = [remember(key).trimEnd(), filesMessage(uploaded)]
      .filter(Boolean)
      .join("\n\n");
    remember(key, next);
    if (draftKeyFor(project, engine) === key) setDraft(next);
  };
  const draftLines = draft.split("\n").length;
  const projectTitle = spaces.find((p) => p.id === project)?.titulo;
  const status = agentStatus(team.agents.find((x) => x.id === agent.id));
  // New conversations use provider protocols; legacy terminal sessions are read-only.
  const composing =
    !selected ||
    (!!selected.structured && !active && !!selected.conversacionId);
  const composeForm = composing ? (
    <form
      className="conversation-compose"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void attach(Array.from(e.dataTransfer.files));
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const brief = draft.trim();
        if (!brief) return;
        const submittedView = view.current;
        const submittedDraft = draft;
        void action(async () => {
          const result = (await teamApi("/agentes/sesiones", {
            motor: engine,
            origen: "sala",
            proyecto: repo || project,
            espacioId: project,
            structured: true,
            brief,
            ...(selected ? { continuar: selected.id } : {}),
            ...choicePayload(models, choice),
          })) as Conversation;
          if (remember(draftKey) === submittedDraft) remember(draftKey, "");
          remember(`sb-chat-selected:${project}:${engine}`, result.id);
          saveChoice(engine, choice);
          if (view.current === submittedView) {
            setDraft((current) => (current === submittedDraft ? "" : current));
            setSessions((current) => [
              result,
              ...current.filter((s) => s.id !== result.id),
            ]);
            setRoute({ project, agent: agent.id, chat: result.id });
          }
        });
      }}
    >
      <label>
        <span className="sr-only">Mensaje para {agent.name}</span>
        <textarea
          ref={draftRef}
          rows={Math.min(14, Math.max(3, draftLines))}
          value={draft}
          maxLength={60000}
          onChange={(e) => {
            setDraft(e.target.value);
            remember(draftKey, e.target.value);
          }}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            void attach(Array.from(e.clipboardData.files));
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const target = e.currentTarget;
                const start = target.selectionStart ?? target.value.length;
                const end = target.selectionEnd ?? target.value.length;
                const value = target.value;
                const next = value.slice(0, start) + "\n" + value.slice(end);
                if (next !== value) draftCursor.current = start + 1;
                setDraft(next);
                remember(draftKey, next);
                target.setSelectionRange?.(start + 1, start + 1);
                return;
              }
              if (!e.shiftKey) {
                e.preventDefault();
                if (draft.trim() && !busy && !uploading && connected) {
                  e.currentTarget.form?.requestSubmit();
                }
              }
            }
          }}
          placeholder="¿En qué trabajamos?"
        />
      </label>
      <div className="conversation-compose-bar">
        <button
          type="button"
          className="button subtle"
          disabled={uploading || isDemo}
          onClick={() => attachInput.current?.click()}
        >
          <Paperclip size={16} aria-hidden="true" />
          {uploading ? "Subiendo…" : "Adjuntar"}
        </button>
        <input
          ref={attachInput}
          type="file"
          multiple
          hidden
          aria-label="Adjuntar archivos al mensaje"
          onChange={(e) => {
            void attach(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        {!selected && (
          <ModelEffortPicker
            models={models}
            choice={choice}
            onChange={setChoice}
          />
        )}
        <button
          className="button primary"
          disabled={busy || uploading || !connected || !draft.trim()}
        >
          {busy
            ? "Enviando…"
            : selected
              ? "Enviar mensaje"
              : "Abrir conversación"}
        </button>
      </div>
      <p className="muted">
        {isDemo
          ? "Las sesiones reales no se inician en la demostración."
          : engine === "deepseek"
            ? "Marina usa la API de DeepSeek y consume su saldo. Enter envía, Ctrl + Enter para nueva línea. Puedes arrastrar o pegar archivos de cualquier tipo aquí."
            : "Nada se ejecuta hasta que envías. Puedes arrastrar o pegar archivos de cualquier tipo aquí. Enter envía, Ctrl + Enter para nueva línea."}
      </p>
    </form>
  ) : null;
  return (
    <section
      className="agent-workspace"
      aria-label="Conversaciones por proyecto"
    >
      <div
        className="conversation-agents"
        role="group"
        aria-label="Elegir agente"
      >
        {characters.map((a) => {
          const state = agentStatus(team.agents.find((x) => x.id === a.id));
          return (
            <button
              key={a.id}
              className={`team-character-card ${agent.id === a.id ? "active" : ""}`}
              aria-pressed={agent.id === a.id}
              title={`${a.name} · ${a.provider} · ${state}`}
              onClick={() => setRoute({ agent: a.id, chat: null })}
            >
              <span className="conversation-agent-face">
                <AgentPortrait id={a.id} size="small" />
                <i className="agent-dot" data-tone={agentTone(state)} />
              </span>
              <span className="conversation-agent-name">{a.name}</span>
              <small className="sr-only">
                {a.provider} · {state}
              </small>
            </button>
          );
        })}
      </div>
      <aside
        className="conversation-history"
        aria-label="Historial de conversaciones"
      >
        <div className="conversation-context">
          <label>
            Proyecto
            <select
              value={project}
              onChange={(e) => {
                remember("sb-team-project", e.target.value);
                setRoute({ project: e.target.value, chat: null });
                setQuery("");
              }}
            >
              {spaces.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.titulo}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>
              {repo ? `Repositorio: ${repo}` : "Sin repositorio"}
            </summary>
            <ProjectRepository
              key={project}
              projectId={project}
              onChange={setLinks}
            />
          </details>
        </div>
        <button
          className="button primary"
          onClick={() => {
            focusDraft.current = true;
            remember(`sb-chat-selected:${project}:${engine}`, "new");
            setRoute({ chat: "new" });
          }}
        >
          Nueva conversación
        </button>
        <button
          className="button mobile-history-toggle"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          Historial · {conversations.length}
        </button>
        <div
          className={`conversation-history-content ${historyOpen ? "expanded" : ""}`}
        >
          {conversations.length > 4 && (
            <label>
              <span className="sr-only">Buscar conversaciones</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar conversaciones"
              />
            </label>
          )}
          {conversations
            .filter((s) =>
              (s.encargo || "")
                .toLocaleLowerCase("es")
                .includes(query.toLocaleLowerCase("es")),
            )
            .map((s) => (
              <button
                className={s.id === selected?.id ? "active" : ""}
                key={s.id}
                onClick={() => {
                  remember(`sb-chat-selected:${project}:${engine}`, s.id);
                  setRoute({ chat: s.id });
                  setHistoryOpen(false);
                }}
              >
                <strong>{s.encargo || "Conversación sin título"}</strong>
                <small>
                  {s.estado} ·{" "}
                  {s.creada
                    ? new Date(s.creada).toLocaleDateString("es-MX")
                    : ""}
                </small>
              </button>
            ))}
          {!conversations.length && (
            <p className="muted">
              Aquí aparecerán tus conversaciones con {agent.name} en este
              proyecto.
            </p>
          )}
        </div>
      </aside>
      <div className={`conversation-main ${selected ? "" : "is-new"}`}>
        <div className="conversation-heading">
          <AgentPortrait id={agent.id} size="small" />
          <div className="conversation-title">
            <h2>
              {agent.name} <small>· {projectTitle}</small>
            </h2>
            <p>
              {agent.provider} · {status}
              {selected && <span role="status"> · {selected.estado}</span>}
            </p>
          </div>
          {selected && !active && (
            <button
              className={`button ${confirmDelete === selected.id ? "danger" : "subtle"}`}
              disabled={busy}
              onBlur={() => setConfirmDelete("")}
              onClick={() => {
                if (confirmDelete !== selected.id) {
                  setConfirmDelete(selected.id);
                  return;
                }
                const id = selected.id;
                setConfirmDelete("");
                void action(async () => {
                  await teamApi("/agentes/sesiones/eliminar", { id });
                  remember(`sb-chat-selected:${project}:${engine}`, "");
                  setRoute({ chat: null });
                });
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              {confirmDelete === selected.id
                ? "Confirmar: eliminar"
                : "Eliminar conversación"}
            </button>
          )}
          {active && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  teamApi("/agentes/sesiones/cancelar", { id: selected.id }),
                )
              }
            >
              <Square size={14} aria-hidden="true" />
              Detener sesión
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Actualizar"
            title="Actualizar"
            onClick={() => {
              onRefresh?.();
              void refresh();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
        {(error || connectionError) && (
          <p role="alert" className="inline-error">
            {error || connectionError}{" "}
            <button className="button" onClick={() => void action(refresh)}>
              Reintentar
            </button>
          </p>
        )}
        <div className="conversation-body">
          {!selected?.structured && (
            <UsageBars motor={engine} contexto={selected?.contexto} />
          )}
          {selected?.structured ? (
            <ProviderConversation
              key={selected.id}
              id={selected.id}
              agentName={agent.name}
            />
          ) : selected ? (
            <div className="conversation-transcript">
              {(selected.mensajes?.length
                ? selected.mensajes
                : [
                    { rol: "user", texto: selected.encargo || "" },
                    { rol: "assistant", texto: selected.resultado || "" },
                  ]
              ).map((m, i) => (
                <article key={i}>
                  <strong>{m.rol === "user" ? "Tú" : agent.name}</strong>
                  <Markdown texto={m.texto} />
                </article>
              ))}
              {selected.harness && (
                <p className="muted">
                  Conversación anterior conservada como historial. Abre una
                  nueva para usar la integración por protocolo.
                </p>
              )}
              {selected.remotoUrl && (
                <a
                  className="button"
                  href={selected.remotoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Abrir harness del proveedor
                </a>
              )}
            </div>
          ) : draftLines > 3 ? null : (
            <div className="conversation-welcome">
              <AgentPortrait id={agent.id} size="medium" />
              <h3>Conversación nueva con {agent.name}</h3>
              <p>
                Escribe tu primer mensaje. Se abrirá su programa aquí mismo, con
                el contexto de {projectTitle}.
              </p>
            </div>
          )}
          {selected?.error && !selected.structured && (
            <p role="alert" className="inline-error">
              {selected.error}
            </p>
          )}
          {selected &&
            !active &&
            (!selected.conversacionId ||
              selected.capacidades?.continuar === false) &&
            !["pendiente", "trabajando"].includes(selected.estado) && (
              <p className="muted">
                Esta conversación ya no se puede continuar. Abre una nueva para
                seguir con {agent.name}.
              </p>
            )}
        </div>
        {selected?.checkpoints?.length ? (
          <details className="conversation-file-changes">
            <summary>Cambios de archivos</summary>
            <HarnessChanges
              id={selected.id}
              agentName={agent.name}
              checkpoints={selected.checkpoints}
              capacidades={selected.capacidades ?? undefined}
              working={!!active}
              visible
            />
          </details>
        ) : null}
        {composeForm}
      </div>
    </section>
  );
}
