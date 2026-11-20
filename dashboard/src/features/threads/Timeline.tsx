import { useEffect, useRef, useState } from "react";
import { MessageItem, WorkItem } from "./items";
import { agentName } from "../agents/characters";
import { RequestCard } from "./RequestCard";
import {
  formatDuration,
  groupTurns,
  type ThreadView,
  type TurnGroup,
} from "./thread-store";

/** "Trabajó 42 s": the turn's work, folded unless it is running. */
function WorkGroup({ group }: { group: TurnGroup }) {
  const [open, setOpen] = useState(group.running);
  useEffect(() => {
    if (group.running) setOpen(true);
  }, [group.running]);
  if (!group.work.length) return null;
  const ms = Date.parse(group.endedAt) - Date.parse(group.startedAt);
  return (
    <section className="thread-work" data-running={group.running || undefined}>
      <button
        type="button"
        className="thread-work-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {group.running
          ? "Trabajando…"
          : `Trabajó ${formatDuration(ms)} · ${group.work.length} ${group.work.length === 1 ? "paso" : "pasos"}`}
      </button>
      {open && (
        <div className="thread-work-list">
          {group.work.map((item) => (
            <WorkItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

export function Timeline({
  view,
  onAnswered,
}: {
  view: ThreadView;
  onAnswered: () => void;
}) {
  const groups = groupTurns(view);
  const end = useRef<HTMLDivElement>(null);
  const last = view.items.at(-1);
  const signature = `${view.items.length}:${last?.id}:${"text" in (last ?? {}) ? (last as { text: string }).text.length : 0}`;
  useEffect(() => {
    const box = end.current?.parentElement;
    if (!box) return;
    // Follow the stream only when the reader is already at the bottom.
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160)
      end.current?.scrollIntoView?.({ block: "end" });
  }, [signature]);
  const requestById = new Map(view.requests.map((r) => [r.id, r]));
  return (
    <div className="thread-timeline" aria-live="polite">
      {groups.map((group, i) => (
        <article key={group.turnId ?? `g${i}`} className="thread-turn">
          {group.prompt && <MessageItem item={group.prompt} />}
          {group.turnId && group.work.length + group.messages.length > 0 && (
            <p className="thread-agent">
              {agentName(
                (group.work[0] ?? group.messages[0])?.agent?.engine ??
                  view.thread.agent.engine,
              )}
            </p>
          )}
          <WorkGroup group={group} />
          {group.messages.map((item) => {
            if (item.kind === "user_request") {
              const request = requestById.get(item.requestId);
              return request ? (
                <RequestCard
                  key={item.id}
                  request={request}
                  threadId={view.thread.id}
                  onAnswered={onAnswered}
                />
              ) : null;
            }
            return <MessageItem key={item.id} item={item} />;
          })}
          {!group.turnId &&
            group.work.map((item) => <WorkItem key={item.id} item={item} />)}
        </article>
      ))}
      {/* Agent questions opened outside a turn have no timeline item. */}
      {view.requests
        .filter(
          (r) =>
            r.status === "open" &&
            !view.items.some(
              (i) => i.kind === "user_request" && i.requestId === r.id,
            ),
        )
        .map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            threadId={view.thread.id}
            onAnswered={onAnswered}
          />
        ))}
      <div ref={end} />
    </div>
  );
}
