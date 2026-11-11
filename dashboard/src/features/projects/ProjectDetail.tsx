import { Link, useParams, useSearchParams } from "react-router-dom";
import { Copy, ChevronLeft, Pencil, CalendarDays, Plus } from "lucide-react";
import { active, dateLabel, newItem, today } from "../../core/model";
import { projectOverview } from "../../core/overview";
import { WaterBar } from "../../components/QuickView";
import { useUI, Empty } from "../../components/ui";
import { plural } from "../../core/labels";
import { PageHeading } from "../../components/PageHeading";
import { TaskRow } from "../tasks/TaskRow";
import { projectPrompt } from "../../core/agent-prompt";
import { save } from "../../core/store";
import { dashboardForProject } from "./dashboards";
import { characters } from "../team/characters";
import { AgentPortrait, agentStatus } from "../team/TeamPrimitives";
import { useTeam } from "../team/team-store";
import { ProjectWork } from "../team/ProjectWork";
import { ProjectRepository } from "../team/ProjectRepository";
import { ReferenceBoard } from "../team/ReferenceBoard";

const views = [
  ["tareas", "Tareas"],
  ["referencias", "Referencias"],
] as const;
type View = (typeof views)[number][0];

const projectStates = [
  ["active", "En marcha"],
  ["paused", "Pausado"],
  ["done", "Completado"],
  ["archived", "Archivado"],
] as const;

const byDate = (a: { date?: string }, b: { date?: string }) =>
  (a.date || "9999").localeCompare(b.date || "9999");

export function ProjectDetail() {
  const { id } = useParams();
  const { items, edit, ask, notify } = useUI();
  const [params, setParams] = useSearchParams();
  const project = items.find(
    (x) => x.kind === "project" && x.id === id && !x.deleted,
  );
  if (!project)
    return (
      <Empty
        heading="Este proyecto no está disponible."
        action={<Link to="/projects">Volver a proyectos</Link>}
      />
    );
  const view: View =
    views.find(([key]) => key === params.get("vista"))?.[0] || "tareas";
  const day = today();
  const tasks = active(items, "task").filter(
    (x) => x.projectId === id && x.status !== "cancelled",
  );
  const summary = projectOverview(items, project.id, day);
  const dashboard = dashboardForProject(project);
  const upcoming = tasks
    .filter((x) => x.status !== "done" && x.id !== summary.next?.id)
    .sort(byDate);
  const finished = tasks.filter((x) => x.status === "done");
  const state = projectStates.some(([key]) => key === project.status)
    ? project.status
    : "active";
  return (
    <div className="project-detail">
      <PageHeading
        title={project.title}
        description={project.area || "Proyecto personal"}
        action={
          <>
            <Link className="button" to="/projects">
              <ChevronLeft size={16} aria-hidden="true" />
              Proyectos
            </Link>
            {dashboard && (
              <Link className="button" to={dashboard.path}>
                Abrir panel
              </Link>
            )}
            <button className="button" onClick={() => edit(project)}>
              <Pencil size={16} aria-hidden="true" />
              Editar
            </button>
          </>
        }
      />
      <div className="project-workbench">
        <div className="project-main">
          <div className="project-toolbar">
            <nav
              className="work-tabs project-tabs"
              aria-label="Secciones del proyecto"
            >
              {views.map(([key, label]) => (
                <button
                  key={key}
                  className={view === key ? "active" : ""}
                  aria-pressed={view === key}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (key === "tareas") next.delete("vista");
                    else next.set("vista", key);
                    setParams(next, { replace: true });
                  }}
                >
                  {label}
                  {key === "tareas" && summary.pending > 0 && (
                    <span className="unread-count">{summary.pending}</span>
                  )}
                </button>
              ))}
            </nav>
            {view === "tareas" && (
              <button
                className="button primary"
                onClick={() => edit(newItem("task", { projectId: project.id }))}
              >
                <Plus size={16} aria-hidden="true" />
                Nueva tarea
              </button>
            )}
          </div>
          {view === "tareas" && (
            <section className="project-panel">
              {summary.next && (
                <div className="project-next-step">
                  <h2>Siguiente paso</h2>
                  <TaskRow task={summary.next} showProject={false} />
                </div>
              )}
              {upcoming.length > 0 && (
                <div className="project-task-group">
                  <h2>
                    Después <span className="count">{upcoming.length}</span>
                  </h2>
                  <div className="project-task-list">
                    {upcoming.map((t) => (
                      <TaskRow key={t.id} task={t} showProject={false} />
                    ))}
                  </div>
                </div>
              )}
              {!summary.pending && (
                <div className="work-empty">
                  <h3>
                    {summary.done
                      ? "Todas las tareas están terminadas"
                      : "Este proyecto aún no tiene tareas"}
                  </h3>
                  <p>
                    {summary.done
                      ? "Añade otra tarea o marca el proyecto como completado."
                      : "Añade la primera tarea o pídele a una agente que proponga el plan."}
                  </p>
                </div>
              )}
              {finished.length > 0 && (
                <details className="completed-details">
                  <summary>
                    {plural(
                      finished.length,
                      "tarea terminada",
                      "tareas terminadas",
                    )}
                  </summary>
                  {finished.map((t) => (
                    <TaskRow key={t.id} task={t} showProject={false} />
                  ))}
                </details>
              )}
            </section>
          )}
          {view === "referencias" && (
            <section className="project-panel">
              <ReferenceBoard projectId={project.id} />
            </section>
          )}
        </div>
        <aside className="project-side" aria-label="Resumen del proyecto">
          <section>
            <h2>Avance</h2>
            {summary.total ? (
              <>
                <p className="project-side-figure">
                  <strong>{summary.percent}%</strong>
                  <span>
                    {summary.done} de {plural(summary.total, "tarea", "tareas")}
                  </span>
                </p>
                <WaterBar
                  value={summary.done}
                  max={summary.total}
                  label={`Tareas terminadas de ${project.title}`}
                />
              </>
            ) : (
              <p className="muted">Sin tareas todavía.</p>
            )}
            {summary.overdue > 0 && (
              <p className="project-side-alert">
                {plural(summary.overdue, "tarea vencida", "tareas vencidas")}
              </p>
            )}
            <label className="project-side-field">
              Estado
              <select
                value={state}
                onChange={(e) =>
                  void save({ ...project, status: e.target.value }).catch((x) =>
                    notify(x.message),
                  )
                }
              >
                {projectStates.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="project-side-date" onClick={() => edit(project)}>
              <CalendarDays size={15} aria-hidden="true" />
              {project.date
                ? `Objetivo: ${dateLabel(project.date)}`
                : "Definir fecha objetivo"}
            </button>
          </section>
          <ProjectTeam projectId={project.id} />
          <button
            className="text-link project-side-copy"
            onClick={() => ask(projectPrompt(project, items, day))}
          >
            <Copy size={14} aria-hidden="true" />
            Copiar encargo para otro agente
          </button>
          <details className="project-settings">
            <summary>Repositorio y carpeta de trabajo</summary>
            <ProjectRepository projectId={project.id} />
          </details>
        </aside>
      </div>
    </div>
  );
}

function ProjectTeam({ projectId }: { projectId: string }) {
  const { openAgent } = useUI();
  const team = useTeam();
  return (
    <section>
      <h2>Pedir ayuda</h2>
      <div className="project-side-agents">
        {characters.map((a) => (
          <button
            key={a.id}
            className="team-character-card"
            onClick={() => openAgent({ agentId: a.id, projectId })}
          >
            <AgentPortrait id={a.id} size="small" />
            <span>
              <strong>{a.name}</strong>
              <small>
                {a.provider} ·{" "}
                {agentStatus(
                  team.agents.find((x) => x.id === a.id),
                  team.flows,
                )}
              </small>
            </span>
          </button>
        ))}
      </div>
      <ProjectWork projectId={projectId} />
    </section>
  );
}
