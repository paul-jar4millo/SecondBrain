import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Bot, Sparkles } from "lucide-react";
import { newItem, today } from "../../core/model";
import { create } from "../../core/store";
import { useUI } from "../../components/ui";
import {
  describeDraft,
  parsePrompt,
  type PromptOptions,
} from "../../core/prompt";
import { agentRequest } from "../../core/agent-prompt";
import { plural } from "../../core/labels";

/** One field to create anything: reads the phrase, previews it, then saves. */
export function PromptBar({
  placeholder,
  plannedDate,
  projectId,
  autoFocus = false,
  onDone,
}: PromptOptions & {
  placeholder: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const { items, edit, notify, ask } = useUI();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const textCursor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = textCursor.current;
    if (pos === null || !textRef.current) return;
    textCursor.current = null;
    textRef.current.setSelectionRange?.(pos, pos);
  }, [text]);
  const day = today();
  const drafts = useMemo(
    () => parsePrompt(text, items, day, { plannedDate, projectId }),
    [text, items, day, plannedDate, projectId],
  );
  // A new project is not in `items` yet, so name it for the lines below it.
  const known = useMemo(
    () => [...items, ...drafts.map((d) => newItem(d.kind, d))],
    [items, drafts],
  );
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!drafts.length || busy) return;
    setBusy(true);
    let saved = 0;
    try {
      // In order: a project must exist before the tasks that point to it.
      for (const { kind, ...data } of drafts) {
        await create(kind, {
          ...data,
          ...(kind === "event"
            ? {
                timezone:
                  localStorage.getItem("sb-zone") || "America/Mexico_City",
              }
            : {}),
        });
        saved += 1;
      }
      notify(
        drafts.length === 1
          ? `Listo: ${drafts[0].title}.`
          : `Listo: ${drafts.length} elementos creados.`,
      );
      setText("");
      onDone?.();
    } catch (error) {
      notify(
        `Se guardaron ${saved} de ${drafts.length}. ${(error as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="prompt-bar" onSubmit={(e) => void submit(e)}>
      <div className="prompt-field">
        <Sparkles size={18} aria-hidden="true" />
        <textarea
          ref={textRef}
          aria-label="Escribe qué quieres crear"
          autoFocus={autoFocus}
          rows={text.includes("\n") ? 4 : 1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
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
                if (next !== value) textCursor.current = start + 1;
                setText(next);
                target.setSelectionRange?.(start + 1, start + 1);
                return;
              }
              if (!e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }
          }}
        />
        <button
          className="prompt-create"
          type="submit"
          disabled={!drafts.length || busy}
        >
          {drafts.length > 1 ? `Crear ${drafts.length}` : "Crear"}
        </button>
      </div>
      {drafts.length > 0 && (
        <div className="prompt-preview" aria-live="polite">
          <ul>
            {drafts.map((draft, index) => (
              <li key={index}>
                <strong>{draft.title}</strong>
                <span>{describeDraft(draft, known, day).join(" · ")}</span>
              </li>
            ))}
          </ul>
          <div className="prompt-actions">
            {drafts.length === 1 && (
              <button
                type="button"
                onClick={() => {
                  const { kind, ...data } = drafts[0];
                  edit(newItem(kind, data));
                  setText("");
                  onDone?.();
                }}
              >
                Ajustar detalles
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                ask(agentRequest(text));
                setText("");
                onDone?.();
              }}
            >
              <Bot size={15} aria-hidden="true" />
              Mejor pedírselo a un agente
            </button>
          </div>
          <span className="sr-only">
            {plural(drafts.length, "elemento listo", "elementos listos")} para
            crear.
          </span>
        </div>
      )}
    </form>
  );
}
