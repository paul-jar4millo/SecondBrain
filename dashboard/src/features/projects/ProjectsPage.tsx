import { useState } from "react";
import { active } from "../../core/model";
import { plural } from "../../core/labels";
import { useUI, Empty } from "../../components/ui";
import { PageHeading, ToolFab } from "../../components/PageHeading";
import { ProjectLine } from "./ProjectLine";
import {
  dashboardForProject,
  projectDashboards,
  ProjectDashboardLinks,
} from "./dashboards";

export function ProjectsPage() {
  const { items, edit } = useUI();
  const [filter, setFilter] = useState("all");
  const allProjects = active(items, "project");
  const projects = allProjects
    .filter((x) =>
      filter === "all"
        ? !["archived", "done", "paused"].includes(x.status || "")
        : x.status === filter,
    )
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  const unlinkedDashboards =
    filter === "all"
      ? projectDashboards.filter(
          (d) =>
            d.fixed &&
            !allProjects.some((p) => dashboardForProject(p)?.id === d.id),
        )
      : [];
  return (
    <>
      <PageHeading
        title="Proyectos"
        description="Tus próximos pasos, con el equipo a mano."
      />
      <div className="filter-bar">
        <div className="tabs">
          {[
            ["all", "En marcha"],
            ["paused", "Pausados"],
            ["done", "Completados"],
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
        <span className="muted">
          {plural(projects.length, "proyecto", "proyectos")}
        </span>
      </div>
      <div className="project-grid">
        {projects.map((p) => (
          <ProjectLine key={p.id} project={p} detailed />
        ))}
        {filter === "all" && unlinkedDashboards.length > 0 && (
          <ProjectDashboardLinks dashboards={unlinkedDashboards} />
        )}
      </div>
      {!projects.length && !unlinkedDashboards.length && (
        <Empty heading="Sin proyectos aquí." />
      )}
      <ToolFab label="Nuevo proyecto" onClick={() => edit("project")} />
    </>
  );
}
