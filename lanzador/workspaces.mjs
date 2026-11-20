import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// Operational project/repository links are independent from the knowledge vault.
/**
 * @param {{ archivo: string, proyectos: Record<string, string>, workspaces: string }} options
 */
export async function openWorkspaces({ archivo, proyectos, workspaces }) {
  /** @type {string[]} */
  const repositorios = [];
  for (const [name, dir] of Object.entries(proyectos)) {
    const git = await stat(path.join(dir, ".git")).catch(
      /** @returns {null} */ () => null,
    );
    if (git && (git.isDirectory() || git.isFile())) repositorios.push(name);
  }
  /** @type {{ revision: number, vinculos: Record<string, string | null> }} */
  let state = await readFile(archivo, "utf8")
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
    leer: () => structuredClone({ ...state, repositorios }),
    /** @param {{ id: string, repositorio: string | null, revision: number }} datos */
    vincular(datos) {
      const operation = queue.then(async () => {
        if (
          !valid(datos.id) ||
          (datos.repositorio !== null &&
            !repositorios.includes(datos.repositorio))
        )
          throw new Error("Vínculo inválido");
        if (datos.revision !== state.revision)
          throw new Error(
            "Conflicto de vínculos; actualiza e inténtalo de nuevo",
          );
        const next = {
          revision: state.revision + 1,
          vinculos: { ...state.vinculos, [datos.id]: datos.repositorio },
        };
        await mkdir(path.dirname(archivo), { recursive: true });
        await writeFile(archivo + ".tmp", JSON.stringify(next), {
          mode: 0o600,
        });
        await rename(archivo + ".tmp", archivo);
        state = next;
        return this.leer();
      });
      queue = operation.catch(() => {});
      return operation;
    },
    /** @param {unknown} id */
    async resolver(id) {
      if (!valid(id)) throw new Error("Proyecto inválido");
      const repositorio = state.vinculos[id] ?? null;
      if (repositorio && !Object.hasOwn(proyectos, repositorio))
        throw new Error("Repositorio no disponible");
      const cwd = repositorio
        ? proyectos[repositorio]
        : path.join(workspaces, id);
      if (!repositorio) await mkdir(cwd, { recursive: true });
      return { cwd, repositorio };
    },
  };
}
