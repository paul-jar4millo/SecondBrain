// Temporary aliases for the Phase 1.5 compatibility release.
export const legacyLauncherPaths = new Map(
  Object.entries({
    "/estado": "/status",
    "/capacidades": "/capabilities",
    "/proyectos": "/projects",
    "/modelos": "/models",
    "/uso": "/usage",
    "/espacios": "/workspaces",
    "/herramientas/catalogo": "/tools/catalog",
    "/herramientas/perfiles": "/tools/profiles",
    "/herramientas/skills/resolver": "/tools/skills/resolve",
  }),
);

/** @typedef {{ revision: number, links: Record<string, string | null>, repositories: string[], repositoryPaths?: Record<string, string> }} WorkspaceView */
/** @typedef {{ id: string, revision: number, repository: string | null }} WorkspaceUpdate */

/** @param {Partial<WorkspaceView> & { vinculos?: WorkspaceView["links"], repositorios?: string[] }} view */
export function canonicalWorkspaces(view) {
  const { vinculos, repositorios, ...rest } = view;
  return {
    ...rest,
    links: view.links ?? vinculos ?? {},
    repositories: view.repositories ?? repositorios ?? [],
  };
}

/** @param {Omit<WorkspaceView, "revision"> & { revision?: number }} view */
export function legacyWorkspaces(view) {
  const { links, repositories, ...rest } = view;
  return { ...rest, vinculos: links, repositorios: repositories };
}

/** @param {{ id: string, revision: number, repositorio: string | null }} data */
export function canonicalWorkspaceUpdate(data) {
  return { id: data.id, revision: data.revision, repository: data.repositorio };
}

/** @param {WorkspaceUpdate} data */
export function legacyWorkspaceUpdate(data) {
  return { id: data.id, revision: data.revision, repositorio: data.repository };
}
