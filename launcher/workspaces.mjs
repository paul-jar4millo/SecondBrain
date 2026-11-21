import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// Operational project/repository links are independent from the knowledge vault.
/**
 * @param {{ archivo: string, proyectos: Record<string, string>, workspaces: string, legacyHttpRoutes?: boolean }} options
 */
export async function openWorkspaces({
  archivo: file,
  proyectos: projects,
  workspaces,
  legacyHttpRoutes = true,
}) {
  /** @type {string[]} */
  const repositories = [];
  for (const [name, dir] of Object.entries(projects)) {
    const git = await stat(path.join(dir, ".git")).catch(
      /** @returns {null} */ () => null,
    );
    if (git && (git.isDirectory() || git.isFile())) repositories.push(name);
  }
  const repositoryPaths = Object.fromEntries(
    repositories.map((name) => [name, projects[name]]),
  );
  // In the compatibility release an older launcher or repo-link script
  // may update vinculos without knowing about links. Both remain readable.
  const { revision, links, vinculos, ...extra } = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return { revision: 0, links: {} };
    });
  /** @type {{ revision: number, links: Record<string, string | null> }} */
  let state = { revision, links: vinculos ?? links ?? {} };
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @param {unknown} id
   * @returns {id is string}
   */
  const valid = (id) =>
    typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  return {
    read: () =>
      structuredClone({
        ...state,
        repositories,
        repositoryPaths,
      }),
    /** @param {{ id: string, repository: string | null, revision: number }} data */
    link(data) {
      const operation = queue.then(async () => {
        if (
          !valid(data.id) ||
          (data.repository !== null && !repositories.includes(data.repository))
        )
          throw new Error("Vínculo inválido");
        if (data.revision !== state.revision)
          throw new Error(
            "Conflicto de vínculos; actualiza e inténtalo de nuevo",
          );
        const next = {
          revision: state.revision + 1,
          links: { ...state.links, [data.id]: data.repository },
        };
        await mkdir(path.dirname(file), { recursive: true });
        const stored = {
          ...extra,
          ...next,
          ...(legacyHttpRoutes ? { vinculos: next.links } : {}),
        };
        await writeFile(file + ".tmp", JSON.stringify(stored), {
          mode: 0o600,
        });
        await rename(file + ".tmp", file);
        state = next;
        return this.read();
      });
      queue = operation.catch(() => {});
      return operation;
    },
    /** @param {unknown} id */
    async resolve(id) {
      if (!valid(id)) throw new Error("Proyecto inválido");
      const repository = Object.hasOwn(state.links, id)
        ? state.links[id]
        : null;
      if (repository && !Object.hasOwn(projects, repository))
        throw new Error("Repositorio no disponible");
      const cwd = repository ? projects[repository] : path.join(workspaces, id);
      if (!repository) await mkdir(cwd, { recursive: true });
      return { cwd, repository };
    },
  };
}
