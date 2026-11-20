// A question, approval or form from the agent, answered inline.
import { useState } from "react";
import { Markdown } from "../../components/Markdown";
import { threadsApi } from "./thread-api";
import type { RequestAnswer, UserRequest } from "./thread-types";

const RESOLVED: Record<string, string> = {
  answered: "Respondida",
  cancelled: "Cancelada",
  expired: "Venció",
};

const ORIGIN: Record<string, string> = {
  app: "desde la app",
  discord: "desde Discord",
  push: "desde una notificación",
  agent: "por el agente",
};

function answerSummary(request: UserRequest) {
  const a = request.answer;
  if (!a) return "";
  const parts: string[] = [];
  if (a.optionId)
    parts.push(
      request.options?.find((o) => o.id === a.optionId)?.label ?? a.optionId,
    );
  if (a.approved !== undefined)
    parts.push(a.approved ? "Aprobado" : "Rechazado");
  if (a.text) parts.push(a.text);
  for (const [k, v] of Object.entries(a.values ?? {}))
    parts.push(
      `${request.fields?.find((f) => f.id === k)?.label ?? k}: ${String(v)}`,
    );
  return parts.join(" · ");
}

export function RequestCard({
  request,
  threadId,
  onAnswered,
}: {
  request: UserRequest;
  threadId: string;
  onAnswered: () => void;
}) {
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = request.status === "open";

  const submit = async (answer: RequestAnswer) => {
    setBusy(true);
    setError("");
    try {
      await threadsApi.answer(threadId, request.id, answer);
      onAnswered();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="thread-request"
      data-open={open || undefined}
      aria-label={`Solicitud: ${request.title}`}
    >
      <p className="thread-work-title">{request.title}</p>
      {request.body && <Markdown texto={request.body} />}
      {!open ? (
        <p className="muted">
          {RESOLVED[request.status] ?? request.status}
          {request.origin ? ` ${ORIGIN[request.origin] ?? ""}` : ""}
          {answerSummary(request) ? `: ${answerSummary(request)}` : ""}
        </p>
      ) : request.kind === "approval" && !request.options?.length ? (
        <div className="thread-request-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void submit({ approved: true })}
          >
            Aprobar
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void submit({ approved: false })}
          >
            Rechazar
          </button>
        </div>
      ) : request.fields?.length ? (
        <form
          className="thread-request-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ values });
          }}
        >
          {request.fields.map((field) => (
            <label key={field.id}>
              {field.label}
              {field.type === "select" ? (
                <select
                  required={field.required}
                  value={String(values[field.id] ?? "")}
                  onChange={(e) =>
                    setValues({ ...values, [field.id]: e.target.value })
                  }
                >
                  <option value="">—</option>
                  {field.options?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={values[field.id] === true}
                  onChange={(e) =>
                    setValues({ ...values, [field.id]: e.target.checked })
                  }
                />
              ) : field.type === "textarea" ? (
                <textarea
                  required={field.required}
                  value={String(values[field.id] ?? "")}
                  onChange={(e) =>
                    setValues({ ...values, [field.id]: e.target.value })
                  }
                />
              ) : (
                <input
                  required={field.required}
                  value={String(values[field.id] ?? "")}
                  onChange={(e) =>
                    setValues({ ...values, [field.id]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          <button type="submit" className="button primary" disabled={busy}>
            Responder
          </button>
        </form>
      ) : (
        <div className="thread-request-form">
          {request.options?.length ? (
            <div className="thread-request-actions">
              {request.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void submit({ optionId: o.id })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="thread-request-text"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void submit({ text: text.trim() });
            }}
          >
            <input
              aria-label="Respuesta"
              placeholder={
                request.options?.length ? "U otra respuesta…" : "Tu respuesta…"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={busy || !text.trim()}>
              Enviar
            </button>
          </form>
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
    </section>
  );
}
