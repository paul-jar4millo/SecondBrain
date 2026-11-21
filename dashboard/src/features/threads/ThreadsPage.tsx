import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeading } from "../../components/PageHeading";
import { useConfirmation } from "../../components/useConfirmation";
import { Composer } from "./Composer";
import { DiffView } from "./DiffView";
import { CloseDialog, NewThreadDialog } from "./dialogs";
import { WorkItem } from "./items";
import { agentName } from "../agents/characters";
import { isDemo } from "../../core/store";
import { threadProjection, useThreadProjection } from "./thread-projection";
import { threadsApi } from "./thread-api";
import { STATUS_LABEL, openRequests, type ThreadView } from "./thread-store";
import { useThread } from "./thread-stream";
import type { InboxEntry, Thread } from "./thread-types";
import { Timeline } from "./Timeline";
import "./threads.css";

function useInbox(projection: ReturnType<typeof useThreadProjection>) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (isDemo || !projection.loaded || projection.error) return;
    let active = true;
    void threadsApi
      .inbox()
      .then(({ entries }) => {
        if (!active) return;
        setEntries(entries);
        setError("");
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [projection]);
  return { entries, error };
}

function ThreadList({
  threads,
  selected,
}: {
  threads: Thread[];
  selected?: string;
}) {
  if (!threads.length)
    return <p className="muted thread-empty">Todavía no hay threads.</p>;
  return (
    <ul className="thread-list">
      {threads.map((t) => (
        <li key={t.id}>
          <Link
            to={`/threads/${t.id}`}
            aria-current={t.id === selected ? "page" : undefined}
            className="thread-list-link"
          >
            <span className="thread-list-title">{t.title}</span>
            <span className="thread-list-meta">
              <span className="thread-status" data-status={t.status}>
                {STATUS_LABEL[t.status]}
              </span>{" "}
              · {agentName(t.agent.engine)}
              {t.repo ? ` · ${t.repo.branch}` : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function InboxList({ entries }: { entries: InboxEntry[] }) {
  if (!entries.length) return null;
  return (
    <section className="thread-inbox" aria-label="Bandeja">
      <h2>Te esperan ({entries.length})</h2>
      <ul>
        {entries.map((e) => (
          <li key={`${e.threadId}:${e.requestId ?? e.reason}`}>
            <Link to={`/threads/${e.threadId}`}>
              <strong>{e.threadTitle}</strong>
              <span>{e.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SidePanel({ view, tick }: { view: ThreadView; tick: number }) {
  const [tab, setTab] = useState<"diff" | "plan">(
    view.thread.repo ? "diff" : "plan",
  );
  const plan = [...view.items]
    .reverse()
    .find((i) => i.kind === "plan" || i.kind === "todo_list");
  return (
    <aside className="thread-side">
      <div className="thread-tabs" role="tablist">
        {view.thread.repo && (
          <button
            type="button"
            className="button"
            role="tab"
            aria-selected={tab === "diff"}
            onClick={() => setTab("diff")}
          >
            Cambios
          </button>
        )}
        <button
          type="button"
          className="button"
          role="tab"
          aria-selected={tab === "plan"}
          onClick={() => setTab("plan")}
        >
          Plan
        </button>
      </div>
      {tab === "diff" && view.thread.repo ? (
        <DiffView threadId={view.thread.id} refreshKey={tick} />
      ) : plan ? (
        <WorkItem item={plan} />
      ) : (
        <p className="muted">El agente aún no ha publicado un plan.</p>
      )}
    </aside>
  );
}

function ThreadDetail({
  id,
  onChanged,
}: {
  id: string;
  onChanged: () => void;
}) {
  const { view, error, mode, reload } = useThread(id);
  const [closing, setClosing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const { confirm, confirmation } = useConfirmation();
  const navigate = useNavigate();
  // Re-read the diff when a turn ends.
  const tick = view?.items.filter((i) => i.kind === "file_change").length ?? 0;
  if (error && !view) return <p className="inline-error">{error}</p>;
  if (!view) return <p role="status">Abriendo thread…</p>;
  const { thread } = view;
  const finished = ["done", "failed", "archived"].includes(thread.status);
  const pending = openRequests(view).length;
  return (
    <div className="thread-detail">
      <header className="thread-header">
        <Link
          to="/threads"
          className="thread-back"
          aria-label="Volver a la lista"
        >
          ←
        </Link>
        <div className="thread-header-text">
          <h2>{thread.title}</h2>
          {thread.parentId && (
            <p className="thread-list-meta">
              Sub-tarea de{" "}
              <Link to={`/threads/${thread.parentId}`}>su thread padre</Link>
            </p>
          )}
          <p className="thread-list-meta">
            <span className="thread-status" data-status={thread.status}>
              {STATUS_LABEL[thread.status]}
            </span>
            {pending > 0 && ` · ${pending} pendiente${pending > 1 ? "s" : ""}`}
            {thread.flow &&
              thread.flow.stages.length > 1 &&
              ` · Etapa ${thread.stageIndex + 1}/${thread.flow.stages.length}: ${thread.flow.stages[thread.stageIndex]?.name ?? ""}`}
            {thread.repo &&
              ` · ${thread.repo.branch} → ${thread.repo.baseBranch}`}
            {thread.prUrl && (
              <>
                {" · "}
                <a href={thread.prUrl} target="_blank" rel="noreferrer">
                  PR
                </a>
              </>
            )}
            {mode === "polling" && " · sin conexión en vivo"}
          </p>
        </div>
        <div className="thread-header-actions">
          <button
            type="button"
            className="button thread-sheet-toggle"
            aria-expanded={sheet}
            onClick={() => setSheet(!sheet)}
          >
            {thread.repo ? "Cambios" : "Plan"}
          </button>
          {!finished && thread.status !== "closing" && (
            <button
              type="button"
              className="button"
              onClick={() => setClosing(true)}
            >
              Cerrar thread
            </button>
          )}
          {thread.status !== "archived" && (
            <button
              type="button"
              className="button subtle"
              onClick={async () => {
                const ok = await confirm(
                  thread.prUrl
                    ? "Se borra el worktree; la rama del PR se conserva."
                    : "Se borran el worktree y la rama del thread.",
                  {
                    title: "Archivar thread",
                    confirmLabel: "Archivar",
                    danger: true,
                  },
                );
                if (!ok) return;
                await threadsApi.archive(thread.id).catch(() => undefined);
                onChanged();
                navigate("/threads");
              }}
            >
              Archivar
            </button>
          )}
        </div>
      </header>
      <div className="thread-body">
        <div className="thread-main">
          <Timeline view={view} onAnswered={onChanged} />
          <Composer view={view} onSent={onChanged} />
        </div>
        <div className="thread-side-wrap" data-open={sheet || undefined}>
          <SidePanel view={view} tick={tick} />
        </div>
      </div>
      {closing && (
        <CloseDialog
          thread={thread}
          onClose={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            reload();
            onChanged();
          }}
        />
      )}
      {confirmation}
    </div>
  );
}

export function ThreadsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useThreadProjection();
  const inbox = useInbox(list);
  const [creating, setCreating] = useState(false);
  return (
    <div className="threads-page" data-selected={id ? true : undefined}>
      <div className="threads-column">
        <PageHeading title="Threads" />
        <button
          type="button"
          className="button primary thread-new"
          onClick={() => setCreating(true)}
        >
          Nuevo thread
        </button>
        {(list.error || inbox.error) && (
          <p className="inline-error">{list.error || inbox.error}</p>
        )}
        <InboxList entries={inbox.entries} />
        {list.loaded || isDemo ? (
          <ThreadList threads={list.threads} selected={id} />
        ) : (
          <p role="status">Cargando threads…</p>
        )}
      </div>
      <div className="threads-view">
        {id ? (
          <ThreadDetail
            key={id}
            id={id}
            onChanged={() => void threadProjection.refresh()}
          />
        ) : (
          <p className="muted thread-empty">
            Elige un thread o crea uno nuevo.
          </p>
        )}
      </div>
      {creating && (
        <NewThreadDialog
          onClose={() => setCreating(false)}
          onCreated={(thread) => {
            setCreating(false);
            void threadProjection.refresh();
            navigate(`/threads/${thread.id}`);
          }}
        />
      )}
    </div>
  );
}
