import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";
import {
  projectDashboards,
  dashboardForProject,
  ProjectDashboardLinks,
} from "../src/features/projects/dashboards";
import type { Item } from "../src/core/model";

it("conserva el panel fijo del canal y permite registrar dashboards programados para otros proyectos", () => {
  const project = {
    id: "synthetic",
    kind: "project",
    vaultPath: "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
  } as Item;
  expect(dashboardForProject(project)?.path).toBe("/projects/mundo-hipotetico");
  expect(
    dashboardForProject({ ...project, vaultPath: "01-Proyectos/Otro.md" }),
  ).toBeUndefined();
  const custom = {
    id: "custom",
    title: "Laboratorio",
    description: "Experimentos",
    path: "/projects/dashboard/laboratorio",
    projectPath: "01-Proyectos/Otro.md",
    fixed: true,
    Component: () => null,
  };
  const registry = [...projectDashboards, custom];
  expect(
    dashboardForProject(
      { ...project, vaultPath: custom.projectPath },
      registry,
    ),
  ).toBe(custom);
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ProjectDashboardLinks, { dashboards: registry }),
    ),
  );
  expect(html).toContain('href="/projects/mundo-hipotetico"');
  expect(html).toContain('href="/projects/dashboard/laboratorio"');
  expect(html).toContain("Laboratorio");
});
