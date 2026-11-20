import { lazy, type ComponentType } from "react";
import { Link } from "react-router-dom";
import type { Item } from "../../core/model";
import { ArrowUpRight } from "lucide-react";

/** Dashboards are code shipped with the app, linked only when the owner requests one. */
export interface ProjectDashboard {
  id: string;
  title: string;
  description: string;
  path: string;
  projectPath: string;
  fixed: boolean;
  Component: ComponentType;
}

export const projectDashboards: readonly ProjectDashboard[] = [
  {
    id: "mundo-hipotetico",
    title: "Mundo Hipotético",
    description: "Canal de videos · producción, métricas y agentes",
    path: "/projects/mundo-hipotetico",
    projectPath: "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
    fixed: true,
    Component: lazy(() => import("../world/WorldPage")),
  },
];

export function dashboardForProject(
  project: Item,
  dashboards = projectDashboards,
) {
  return project.kind === "project"
    ? dashboards.find((d) => d.projectPath === project.vaultPath)
    : undefined;
}

export function ProjectDashboardLinks({
  dashboards = projectDashboards,
}: {
  dashboards?: readonly ProjectDashboard[];
}) {
  return (
    <>
      {dashboards
        .filter((d) => d.fixed)
        .map((d) => (
          <Link key={d.id} className="project-channel" to={d.path}>
            <strong>
              {d.title}
              <ArrowUpRight size={20} aria-hidden="true" />
            </strong>
            <span>{d.description}</span>
            <span className="channel-action">Abrir panel del canal</span>
          </Link>
        ))}
    </>
  );
}
