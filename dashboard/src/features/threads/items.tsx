// One renderer per item kind. Work items (commands, edits, tools…) are
// compact; messages are shown in full.
import { useState } from "react";
import { Markdown } from "../../components/Markdown";
import { DiffFiles } from "./DiffView";
import type { Item, ItemOf } from "./thread-types";

const STEP_MARK = { pending: "○", in_progress: "◐", completed: "●" } as const;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const TOOL_LABELS: Record<string, string> = {
  thread_handoff: "Pasa a la siguiente etapa",
  thread_report_review: "Reporta la revisión",
  thread_request_subtask: "Pide una sub-tarea",
  thread_subtask_status: "Consulta sus sub-tareas",
  thread_integrate_subtask: "Integra una sub-tarea",
  thread_ask_user: "Te pregunta",
  agent_usage: "Consulta el uso de los planes",
  brain_context: "Lee el contexto del vault",
  brain_read: "Lee una nota",
  brain_search: "Busca en el vault",
  brain_list: "Lista notas",
  brain_write: "Escribe una nota",
};

/** Tool names without the MCP plumbing: mcp__secondbrain__brain_read → "Lee una nota". */
export function toolLabel(name: string, server?: string | null) {
  const bare = name.replace(/^mcp__.+?__/, "");
  if (TOOL_LABELS[bare]) return TOOL_LABELS[bare];
  if (["Bash", "PowerShell", "shell"].includes(bare)) return "Comando";
  if (server && !["secondbrain"].includes(server)) return `${server}: ${bare}`;
  return bare;
}

function Steps({
  steps,
}: {
  steps: { text: string; status: keyof typeof STEP_MARK }[];
}) {
  return (
    <ol className="thread-steps">
      {steps.map((s, i) => (
        <li key={i} data-status={s.status}>
          <span aria-hidden>{STEP_MARK[s.status]}</span> {s.text}
        </li>
      ))}
    </ol>
  );
}

function Command({ item }: { item: ItemOf<"command"> }) {
  const [open, setOpen] = useState(item.status === "in-progress");
  const failed = item.exitCode !== null && item.exitCode !== 0;
  return (
    <div className="thread-work-item" data-failed={failed || undefined}>
      <button
        type="button"
        className="thread-work-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <code>$ {item.command}</code>
        <span className="thread-work-meta">
          {item.status === "in-progress"
            ? "ejecutando…"
            : item.exitCode === null
              ? ""
              : `salida ${item.exitCode}`}
        </span>
      </button>
      {open && item.output && (
        <pre className="thread-output">{item.output.slice(-20_000)}</pre>
      )}
    </div>
  );
}

function FileChange({ item }: { item: ItemOf<"file_change"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thread-work-item">
      <button
        type="button"
        className="thread-work-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          Editó{" "}
          {item.diffs.length === 1
            ? item.diffs[0]!.path
            : `${item.diffs.length} archivos`}
        </span>
        <span className="thread-work-meta">
          <span className="diff-add">
            +{item.diffs.reduce((n, d) => n + d.additions, 0)}
          </span>{" "}
          <span className="diff-del">
            −{item.diffs.reduce((n, d) => n + d.deletions, 0)}
          </span>
        </span>
      </button>
      {open && <DiffFiles files={item.diffs} />}
    </div>
  );
}

function Folded({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thread-work-item">
      <button
        type="button"
        className="thread-work-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        {meta && <span className="thread-work-meta">{meta}</span>}
      </button>
      {open && <div className="thread-work-body">{children}</div>}
    </div>
  );
}

export function WorkItem({ item }: { item: Item }) {
  switch (item.kind) {
    case "command":
      return <Command item={item} />;
    case "file_change":
      return <FileChange item={item} />;
    case "reasoning":
      return (
        <Folded label="Razonamiento">
          <Markdown texto={item.text} />
        </Folded>
      );
    case "plan":
      return (
        <div className="thread-work-item">
          <p className="thread-work-title">Plan</p>
          {item.explanation && <p>{item.explanation}</p>}
          <Steps steps={item.steps} />
        </div>
      );
    case "todo_list":
      return (
        <div className="thread-work-item">
          <p className="thread-work-title">Pendientes</p>
          <Steps steps={item.todos} />
        </div>
      );
    case "tool_call":
      return (
        <Folded
          label={toolLabel(
            // Codex reports MCP calls as mcpToolCall with the tool as input.
            item.name === "mcpToolCall" && typeof item.input === "string"
              ? item.input
              : item.name,
            item.server,
          )}
          meta={
            item.error ? "no se pudo" : item.status === "in-progress" ? "…" : ""
          }
        >
          <pre className="thread-output">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {(item.output || item.error) && (
            <pre className="thread-output">{item.error ?? item.output}</pre>
          )}
        </Folded>
      );
    case "subagent":
      return (
        <Folded label={`Subagente: ${item.name}`} meta={item.description}>
          {item.prompt && <Markdown texto={item.prompt} />}
          {item.result && <Markdown texto={item.result} />}
        </Folded>
      );
    case "notice":
      // Older threads logged every automatic approval.
      if (item.code === "auto-approved") return null;
      return (
        <p className="thread-notice" data-level={item.level}>
          {item.text}
        </p>
      );
    default:
      return null;
  }
}

export function MessageItem({
  item,
  stages = [],
}: {
  item: Item;
  /** Stage names of the thread's flow, for hand-offs. */
  stages?: string[];
}) {
  switch (item.kind) {
    case "assistant_message":
      if (!item.text.trim()) return null;
      return (
        <div className="thread-message" data-role="agent">
          <Markdown texto={item.text} />
        </div>
      );
    case "user_message":
      return (
        <div className="thread-message" data-role="user">
          {item.delivery !== "send" && (
            <span className="thread-delivery">
              {item.delivery === "steer" ? "Redirigido" : "En cola"}
            </span>
          )}
          <p>{item.text}</p>
        </div>
      );
    case "review":
      return (
        <div className="thread-message" data-role="review">
          <p className="thread-work-title">
            Revisión {item.round}:{" "}
            {item.verdict === "approved"
              ? "aprobado"
              : item.verdict === "changes-requested"
                ? "pide cambios"
                : "comentario"}
          </p>
          <Markdown texto={item.summary} />
          {item.findings.length > 0 && (
            <ul>
              {item.findings.map((f, i) => (
                <li key={i}>
                  <strong>{f.severity}</strong>{" "}
                  {f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}
                  {f.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "handoff":
      return (
        <div className="thread-message" data-role="handoff">
          <p className="thread-work-title">
            Traspaso: {stages[item.fromStage] ?? `etapa ${item.fromStage + 1}`}{" "}
            → {stages[item.toStage] ?? `etapa ${item.toStage + 1}`}
          </p>
          <Markdown texto={item.narrative} />
          {item.openItems.length > 0 && (
            <>
              <p className="thread-work-title">Pendientes</p>
              <ul>
                {item.openItems.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </>
          )}
          {(item.brief.files.length > 0 ||
            item.brief.commands.length > 0 ||
            item.brief.errors.length > 0) && (
            <details>
              <summary>
                {[
                  plural(item.brief.files.length, "archivo", "archivos"),
                  plural(item.brief.commands.length, "comando", "comandos"),
                  item.brief.failedTests.length > 0 &&
                    plural(
                      item.brief.failedTests.length,
                      "con tests fallidos",
                      "con tests fallidos",
                    ),
                  item.brief.errors.length > 0 &&
                    plural(item.brief.errors.length, "error", "errores"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </summary>
              <ul>
                {item.brief.diffstat.map((f) => (
                  <li key={f.path}>
                    {f.path} (+{f.additions} −{f.deletions})
                  </li>
                ))}
                {item.brief.failedTests.map((t, i) => (
                  <li key={`t${i}`}>Tests fallidos: {t}</li>
                ))}
                {item.brief.errors.map((e, i) => (
                  <li key={`e${i}`}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      );
    default:
      return null;
  }
}
