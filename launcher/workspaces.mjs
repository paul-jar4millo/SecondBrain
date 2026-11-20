import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// Operational project/repository links are independent from the knowledge vault.
/**
 * @param {{ archivo: string, proyectos: Record<string, string>, workspaces: string }} options
 */
export async function openWorkspaces({
  archivo: file,
  proyectos: projects,
  workspaces,
}) {
  /** @type {string[]} */
  const repositories = [];
  for (const [name, dir] of Object.entries(projects)) {
    const git = await stat(path.join(dir, ".git")).catch(
      /** @returns {null} */ () => null,
    );
    if (git && (git.isDirectory() || git.isFile())) repositories.push(name);
  }
  /** @type {{ revision: number, vinculos: Record<string, string | null> }} */
  let state = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return { revision: 0, vinculos: {} };
    });
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @param {unknown} id
   * @returns {id is string}
   */
  const valid = (id) =>
    typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  return {
    leer: () => structuredClone({ ...state, repositorios: repositories }),
    /** @param {{ id: string, repositorio: string | null, revision: number }} data */
    vincular(data) {
      const operation = queue.then(async () => {
        if (
          !valid(data.id) ||
          (data.repositorio !== null &&
            !repositories.includes(data.repositorio))
        )
          throw new Error("Vínculo inválido");
        if (data.revision !== state.revision)
          throw new Error(
            "Conflicto de vínculos; actualiza e inténtalo de nuevo",
          );
        const next = {
          revision: state.revision + 1,
          vinculos: { ...state.vinculos, [data.id]: data.repositorio },
        };
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file + ".tmp", JSON.stringify(next), {
          mode: 0o600,
        });
        await rename(file + ".tmp", file);
        state = next;
        return this.leer();
      });
      queue = operation.catch(() => {});
      return operation;
    },
    /** @param {unknown} id */
    async resolver(id) {
      if (!valid(id)) throw new Error("Proyecto inválido");
      const repository = state.vinculos[id] ?? null;
      if (repository && !Object.hasOwn(projects, repository))
        throw new Error("Repositorio no disponible");
      const cwd = repository ? projects[repository] : path.join(workspaces, id);
      if (!repository) await mkdir(cwd, { recursive: true });
      return { cwd, repositorio: repository };
    },
  };
}
