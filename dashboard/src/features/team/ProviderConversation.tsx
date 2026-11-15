import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { teamApi } from "./team-store";
import "./provider-conversation.css";

export interface ProviderItem {
  id: string;
  tipo: "usuario" | "asistente" | "herramienta";
  texto?: string;
  ts?: string;
  herramienta?: {
    nombre: string;
    resumen?: string;
    resultado?: string;
    estado: string;
  };
}
export interface ProviderRequest {
  id: string;
  kind: "question" | "approval";
  title: string;
  detail?: string;
  status: string;
  createdAt?: string;
  answer?: { answers?: Record<string, string>; decision?: string };
  choices?: string[];
  labels?: Record<string, string>;
  questions?: {
    id: string;
    question: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
}
export interface ProviderSnapshot {
  seq: number;
  items: ProviderItem[];
  requests: ProviderRequest[];
  status: string;
  error?: string;
}

const decisions: Record<string, string> = {
  accept: "Permitir una vez",
  decline: "Rechazar",
  cancel: "Cancelar",
};

export function RequestCard({
  sessionId,
  request,
}: {
  sessionId: string;
  request: ProviderRequest;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [error, setError] = useState("");
  const responseId = useRef(crypto.randomUUID());
  const attempt = useRef<string | null>(null);
  const pending = request.status === "pending" && !delivered;
  const send = async (decision?: string) => {
    setBusy(true);
    setError("");
    const answer = JSON.stringify({
      answers: decision ? undefined : answers,
      decision,
    });
    if (attempt.current !== null && attempt.current !== answer)
      responseId.current = crypto.randomUUID();
    attempt.current = answer;
    try {
      await teamApi("/agentes/conversacion/responder", {
        id: sessionId,
        requestId: request.id,
        responseId: responseId.current,
        ...(decision ? { decision } : { answers }),
      });
      setDelivered(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="provider-request" aria-label={request.title}>
      <span className="provider-eyebrow">
        {request.kind === "question" ? "Tu respuesta" : "Tu aprobación"}
      </span>
      <h3>{request.title}</h3>
      {request.detail && <pre>{request.detail}</pre>}
      {pending ? (
        request.kind === "question" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {request.questions?.map((question) => (
              <fieldset key={question.id} disabled={busy}>
                <legend>{question.question}</legend>
                <div className="provider-options">
                  {question.options?.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className="button"
                      aria-pressed={
                        question.multiSelect
                          ? (answers[question.id] || "")
                              .split(", ")
                              .includes(option.label)
                          : answers[question.id] === option.label
                      }
                      onClick={() =>
                        setAnswers((current) => {
                          const chosen = (current[question.id] || "")
                            .split(", ")
                            .filter(Boolean);
                          return {
                            ...current,
                            [question.id]: question.multiSelect
                              ? (chosen.includes(option.label)
                                  ? chosen.filter(
                                      (value) => value !== option.label,
                                    )
                                  : [...chosen, option.label]
                                ).join(", ")
                              : option.label,
                          };
                        })
                      }
                    >
                      {option.label}
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </button>
                  ))}
                </div>
                <label>
                  <span className="sr-only">
                    Respuesta: {question.question}
                  </span>
                  <input
                    value={answers[question.id] || ""}
                    onChange={(e) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: e.target.value,
                      }))
                    }
                    placeholder="Elige una opción o escribe tu respuesta"
                    required
                  />
                </label>
              </fieldset>
            ))}
            <button className="button primary" disabled={busy}>
              {busy ? "Enviando respuesta…" : "Confirmar respuesta"}
            </button>
          </form>
        ) : (
          <div className="provider-options">
            {request.choices?.map((choice) => (
              <button
                type="button"
                className="button"
                key={choice}
                disabled={busy}
                onClick={() => void send(choice)}
              >
                {request.labels?.[choice] || decisions[choice] || choice}
              </button>
            ))}
          </div>
        )
      ) : (
        <>
          {request.questions?.map((question) => (
            <p key={question.id}>
              {question.question}
              {request.answer?.answers?.[question.id] && (
                <strong> · {request.answer.answers[question.id]}</strong>
              )}
            </p>
          ))}
          <p className="muted">
            {delivered || request.status === "answered"
              ? "Respuesta enviada. Se conserva en esta conversación."
              : "Esta solicitud ya no está vigente. Puedes continuar con un nuevo mensaje."}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function ConversationContent({
  id,
  agentName,
  snapshot,
}: {
  id: string;
  agentName: string;
  snapshot: ProviderSnapshot;
}) {
  return (
    <>
      {snapshot.items.map((item) =>
        item.tipo === "herramienta" ? (
          <details className="provider-tool" key={item.id}>
            <summary>
              {item.herramienta?.nombre}{" "}
              <span>
                {item.herramienta?.estado === "pendiente"
                  ? "En curso"
                  : item.herramienta?.estado === "error"
                    ? "Con error"
                    : "Completada"}
              </span>
            </summary>
            {item.herramienta?.resumen && <pre>{item.herramienta.resumen}</pre>}
            {item.herramienta?.resultado && (
              <pre>{item.herramienta.resultado}</pre>
            )}
          </details>
        ) : (
          <article
            className={`provider-message ${item.tipo === "usuario" ? "is-user" : ""}`}
            key={item.id}
          >
            <strong>{item.tipo === "usuario" ? "Tú" : agentName}</strong>
            <Markdown texto={item.texto || ""} />
          </article>
        ),
      )}
      {snapshot.requests.map((request) => (
        <RequestCard key={request.id} sessionId={id} request={request} />
      ))}
    </>
  );
}

export function ProviderConversation({
  id,
  agentName,
}: {
  id: string;
  agentName: string;
}) {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot>({
    seq: -1,
    items: [],
    requests: [],
    status: "",
  });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const source = new EventSource(
      `/api/v1/agentes/conversacion/stream?id=${encodeURIComponent(id)}`,
    );
    source.addEventListener("conversation", (event) => {
      try {
        const next = JSON.parse(
          (event as MessageEvent).data,
        ) as ProviderSnapshot;
        setSnapshot((current) => (next.seq >= current.seq ? next : current));
        setConnected(true);
        setError("");
      } catch {
        setError("No se pudo leer la actualización del proveedor.");
      }
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [id]);
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView?.({ block: "nearest" });
  }, [snapshot]);
  return (
    <div
      className="provider-conversation"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
      }}
    >
      <div className="provider-connection" role="status">
        {connected
          ? snapshot.status === "trabajando"
            ? "Trabajando · los detalles aparecen debajo"
            : "Conversación actualizada"
          : "Conectando con el proveedor…"}
      </div>
      <ConversationContent id={id} agentName={agentName} snapshot={snapshot} />
      {snapshot.error && (
        <p className="inline-error" role="alert">
          {snapshot.error}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div ref={end} />
    </div>
  );
}
