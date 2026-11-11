import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarDays } from "lucide-react";
import { dateLabel, today, type Item } from "../../core/model";
import { projectOverview } from "../../core/overview";
import {
  plainTitle,
  plural,
  projectStatusLabel,
  statusLabel,
} from "../../core/labels";
import { useUI } from "../../components/ui";
import { WaterBar } from "../../components/QuickView";
import { ProjectAgents, StatusTag } from "../team/TeamPrimitives";
import { dashboardForProject } from "./dashboards";

/** A project in one line: what it is, what comes next, how far it has gone. */
export function ProjectLine({
  project,
  detailed = false,
}: {
  project: Item;
  detailed?: boolean;
}) {
  const { items } = useUI();
  const day = today();
  const summary = projectOverview(items, project.id, day);
  const dashboard = dashboardForProject(project);
  return (
    <article className={detailed ? "project-card" : "project-line"}>
      {detailed && (
        <div className="project-card-top">
          <span>{project.area || "Proyecto personal"}</span>
          <StatusTag state={project.status}>
            {projectStatusLabel[project.status || "active"] ||
              statusLabel[project.status || "active"] ||
              "En marcha"}
          </StatusTag>
        </div>
      )}
      <Link className="project-card-link" to={"/projects/" + project.id}>
        <h3>{project.title}</h3>
        <p>
          {summary.next ? (
            <>
              <span>Sigue:</span> {plainTitle(summary.next.title)}
            </>
          ) : (
            "Falta definir el siguiente paso"
          )}
        </p>
        {detailed && (
          <ArrowUpRight
            className="project-open-arrow"
            size={20}
            aria-hidden="true"
          />
        )}
      </Link>
      <div className="project-line-progress">
        <strong>
          {summary.total
            ? `${summary.done} de ${plural(summary.total, "tarea", "tareas")}`
            : "Sin tareas definidas"}
        </strong>
        {summary.total > 0 && (
          <WaterBar
            value={summary.done}
            max={summary.total}
            label={`Tareas terminadas de ${project.title}`}
          />
        )}
        {summary.overdue > 0 && (
          <small>{plural(summary.overdue, "vencida", "vencidas")}</small>
        )}
      </div>
      {detailed && (
        <p className="project-card-date">
          <CalendarDays size={14} aria-hidden="true" />
          {project.date
            ? `Objetivo: ${dateLabel(project.date)}`
            : "Sin fecha objetivo"}
        </p>
      )}
      <ProjectAgents projectId={project.id} />
      {detailed && dashboard && (
        <Link className="button project-panel-link" to={dashboard.path}>
          Abrir panel del canal <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      )}
    </article>
  );
}
