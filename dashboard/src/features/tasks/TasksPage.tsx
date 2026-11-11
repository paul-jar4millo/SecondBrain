import { useState } from "react";
import { type Item, active, today } from "../../core/model";
import { useUI, Empty, SectionTitle, SelectFilter } from "../../components/ui";
import { PageHeading, ToolFab } from "../../components/PageHeading";
import { TaskRow } from "./TaskRow";
import { LooseIdeas } from "./LooseIdeas";
import { FocusTimer } from "./FocusTimer";
import { useSearchParams } from "react-router-dom";
export function TasksPage() {
  const { items, edit } = useUI();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") || "all";
  const setFilter = (value: string) => setParams({ filter: value });
  const [project, setProject] = useState("");
  const tasks = active(items, "task").filter(
    (x) =>
      (!project || x.projectId === project) &&
      (filter === "done"
        ? x.status === "done"
        : x.status !== "done" && x.status !== "cancelled") &&
      (filter !== "today" || x.date === today() || x.plannedDate === today()) &&
      (filter !== "overdue" || (!!x.date && x.date < today())) &&
      (filter !== "waiting" || x.status === "waiting") &&
      (filter !== "undated" || !x.date),
  );
  const groups =
    filter === "all"
      ? ([
          ["Lo importante", tasks.filter((x) => x.priority)],
          ["Siguientes acciones", tasks.filter((x) => !x.priority)],
        ] as [string, Item[]][])
      : ([["", tasks]] as [string, Item[]][]);
  return (
    <>
      <PageHeading
        title="Tareas"
        description="Marca lo terminado, elige tus prioridades y consulta al equipo cuando necesites ayuda."
      />
      <LooseIdeas />
      <div className="filter-bar">
        <div className="tabs">
          {[
            ["all", "Pendientes"],
            ["today", "Hoy"],
            ["overdue", "Vencidas"],
            ["waiting", "En espera"],
            ["done", "Completadas"],
          ].map(([v, t]) => (
            <button
              key={v}
              className={filter === v ? "active" : ""}
              onClick={() => setFilter(v)}
            >
              {t}
            </button>
          ))}
        </div>
        <SelectFilter
          label="Filtrar por proyecto"
          value={project}
          onChange={setProject}
          options={[
            ["", "Todos los proyectos"],
            ...active(items, "project").map(
              (p) => [p.id, p.title] as [string, string],
            ),
          ]}
        />
      </div>
      <div className="list-panel">
        {tasks.length ? (
          groups.map(
            ([title, list]) =>
              list.length > 0 && (
                <section key={title}>
                  {title && <SectionTitle title={title} count={list.length} />}{" "}
                  {list
                    .sort((a, b) =>
                      (a.date || "9999").localeCompare(b.date || "9999"),
                    )
                    .map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                </section>
              ),
          )
        ) : (
          <Empty heading="Sin tareas." />
        )}
      </div>
      <FocusTimer />
      <ToolFab label="Nueva tarea" onClick={() => edit("task")} />
    </>
  );
}
