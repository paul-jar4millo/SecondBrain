import { Bot, Check, Copy, Star } from "lucide-react";
import { useId, useState } from "react";
import {
  type Item,
  active,
  today,
  dateLabel,
  projectName,
  nextOccurrence,
} from "../../core/model";
import { useUI } from "../../components/ui";
import { plainTitle } from "../../core/labels";
import { splash } from "../../components/Alive";
import { save, create, isDemo } from "../../core/store";
import { taskPrompt } from "../../core/agent-prompt";
import { characters } from "../agents/characters";
import { AgentPortrait } from "../agents/TeamPrimitives";
export function TaskRow({
  task,
  showProject = true,
}: {
  task: Item;
  showProject?: boolean;
}) {
  const { items, edit, notify, ask, openThread } = useUI();
  const [choosingAgent, setChoosingAgent] = useState(false);
  const choicesId = useId();
  const done = task.status === "done";
  const title = plainTitle(task.title);
  const details = [
    showProject &&
      (projectName(items, task.projectId) || task.area || "Personal"),
    task.recurrence && "Se repite",
    task.status === "waiting" && "En espera",
  ]
    .filter(Boolean)
    .join(" · ");
  async function toggle(button: HTMLElement) {
    if (!done) splash(button);
    try {
      await save({ ...task, status: done ? "pending" : "done" });
      if (isDemo && !done && task.recurrence) {
        const next = nextOccurrence(
          task.date || task.plannedDate || today(),
          task.recurrence,
          task.recurrenceDay,
        );
        await create("task", {
          ...task,
          id: crypto.randomUUID(),
          version: 0,
          status: "pending",
          priority: false,
          date: next,
          plannedDate: next,
          recurrenceDay:
            task.recurrenceDay ||
            Number((task.date || task.plannedDate || today()).slice(8)),
        });
      }
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <div className={"task-row " + (done ? "completed" : "")}>
      <button
        className="check-button"
        aria-label={done ? `Reabrir ${title}` : `Completar ${title}`}
        aria-pressed={done}
        onClick={(e) => void toggle(e.currentTarget)}
      >
        {done && <Check size={13} />}
      </button>
      <button className="task-text" onClick={() => edit(task)}>
        <span>{title}</span>
        {details && <small>{details}</small>}
      </button>
      {task.date && (
        <span
          className={"due " + (task.date < today() && !done ? "overdue" : "")}
        >
          {task.date === today() ? "Hoy" : dateLabel(task.date)}
        </span>
      )}
      {!done && (
        <button
          className="icon-button"
          title="Consultar al equipo"
          aria-label={`Consultar equipo: ${title}`}
          aria-expanded={choosingAgent}
          aria-controls={choosingAgent ? choicesId : undefined}
          onClick={() => setChoosingAgent((v) => !v)}
        >
          <Bot size={16} />
        </button>
      )}
      <button
        className={
          "icon-button star-button " +
          (task.priority && !done ? "is-starred" : "")
        }
        title={
          task.priority ? "Quitar de prioridades" : "Elegir como prioridad"
        }
        aria-label={
          task.priority ? "Quitar de prioridades" : "Elegir como prioridad"
        }
        onClick={() => {
          if (
            !task.priority &&
            active(items, "task").filter(
              (x) =>
                x.priority && !["done", "cancelled"].includes(x.status || ""),
            ).length >= 3
          ) {
            notify(
              "Ya tienes tres prioridades. Quita una para dar espacio a esta.",
            );
            return;
          }
          void save({ ...task, priority: !task.priority }).catch((e) =>
            notify(e.message),
          );
        }}
      >
        <Star
          size={15}
          fill={task.priority && !done ? "currentColor" : "none"}
        />
      </button>
      {choosingAgent && !done && (
        <div
          className="task-agent-choices"
          id={choicesId}
          role="group"
          aria-label="Equipo para esta tarea"
        >
          <span>Consulta una agente antes de encargarle la tarea</span>
          <div>
            {characters.map((a) => (
              <button
                key={a.id}
                aria-label={`Consultar a ${a.name} para esta tarea`}
                onClick={() =>
                  openThread({
                    engine: a.engine,
                    projectId: task.projectId,
                    prompt: taskPrompt(task, items),
                  })
                }
              >
                <AgentPortrait id={a.id} />
                <span>{a.name}</span>
              </button>
            ))}
          </div>
          <button
            className="text-link"
            onClick={() => ask(taskPrompt(task, items))}
          >
            <Copy size={14} aria-hidden="true" />
            Copiar encargo para otro agente
          </button>
        </div>
      )}
    </div>
  );
}
