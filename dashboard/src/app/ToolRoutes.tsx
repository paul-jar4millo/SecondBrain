import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { projectDashboards } from "../features/projects/dashboards";
const TasksPage = lazy(() =>
  import("../features/tasks/TasksPage").then((m) => ({ default: m.TasksPage })),
);
const ProjectsPage = lazy(() =>
  import("../features/projects/ProjectsPage").then((m) => ({
    default: m.ProjectsPage,
  })),
);
const ProjectDetail = lazy(() =>
  import("../features/projects/ProjectDetail").then((m) => ({
    default: m.ProjectDetail,
  })),
);
const ThreadsPage = lazy(() =>
  import("../features/threads/ThreadsPage").then((m) => ({
    default: m.ThreadsPage,
  })),
);
const FinancePage = lazy(() =>
  import("../features/finance/FinancePage").then((m) => ({
    default: m.FinancePage,
  })),
);
const FilesPage = lazy(() =>
  import("../features/files/FilesPage").then((m) => ({
    default: m.FilesPage,
  })),
);
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);
export default function ToolRoutes() {
  return (
    <Suspense fallback={<p role="status">Abriendo herramienta…</p>}>
      <Routes>
        <Route path="/today" element={<Navigate to="/projects" replace />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/inbox" element={<Navigate to="/tasks" replace />} />
        <Route path="/agenda" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/team" element={<Navigate to="/threads" replace />} />
        <Route path="/threads" element={<ThreadsPage />} />
        <Route path="/threads/:id" element={<ThreadsPage />} />
        {projectDashboards.map(({ id, path, Component }) => (
          <Route
            key={id}
            path={path}
            element={
              <Suspense fallback={<p>Abriendo proyecto…</p>}>
                <Component />
              </Suspense>
            }
          />
        ))}
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/review" element={<Navigate to="/projects" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
