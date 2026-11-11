import { type Item, active } from "../../core/model";
import { plural } from "../../core/labels";
import { save } from "../../core/store";
import { useUI } from "../../components/ui";

/** Captures agents or old devices left in the vault; shown only if any exist. */
export function LooseIdeas() {
  const { items, edit, notify, trash } = useUI();
  const ideas = active(items, "inbox")
    .filter((x) => x.status === "unprocessed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!ideas.length) return null;
  const makeTask = (idea: Item) =>
    save({ ...idea, kind: "task", status: "pending" })
      .then(() => notify("Ahora es una tarea."))
      .catch((e) => notify((e as Error).message));
  return (
    <details className="loose-ideas">
      <summary>
        {plural(ideas.length, "idea sin ordenar", "ideas sin ordenar")}
      </summary>
      {ideas.map((idea) => (
        <div key={idea.id}>
          <button className="loose-title" onClick={() => edit(idea)}>
            {idea.title}
          </button>
          <button className="text-link" onClick={() => void makeTask(idea)}>
            Hacer tarea
          </button>
          <button
            className="text-link"
            aria-label={"Archivar " + idea.title}
            onClick={() => trash(idea)}
          >
            Archivar
          </button>
        </div>
      ))}
    </details>
  );
}
