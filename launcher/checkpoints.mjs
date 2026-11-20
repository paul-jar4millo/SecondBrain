import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LauncherError } from "./errors.mjs";
/** @import { LauncherSession, SessionCheckpoint, SessionRegistry } from "./session-types.d.ts" */

/** @typedef {{ esRepo: boolean, tieneRemoto: boolean, remotoGithub: boolean }} RepositoryInfo */
/** @typedef {{ env?: NodeJS.ProcessEnv, timeout?: number, max?: number, tolerarExceso?: boolean }} CheckpointGitOptions */
/** @typedef {(cwd: string, args: string[], options?: CheckpointGitOptions) => Promise<{ stdout: string, excedido?: boolean }>} CheckpointGit */
/** @typedef {Pick<SessionCheckpoint, "tipo" | "de">} CheckpointMetadata */

export const MAX_CHECKPOINTS = 50;
export const MAX_PATCH = 1024 * 1024;
const MESSAGE = 120;
const IDENTITY = {
  GIT_AUTHOR_NAME: "SecondBrain",
  GIT_AUTHOR_EMAIL: "checkpoint@secondbrain.invalid",
  GIT_COMMITTER_NAME: "SecondBrain",
  GIT_COMMITTER_EMAIL: "checkpoint@secondbrain.invalid",
};
/** @param {string} id @param {number} n */
const refOf = (id, n) => `refs/secondbrain/checkpoints/${id}/${n}`;
/** @param {unknown} text */
const plain = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE);

/**
 * Checkpoints of a working tree as hidden refs. Nothing here touches the user's
 * index, branch, stash or HEAD: trees are built in a throwaway index file.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import("./git.mjs").createGit>, "git">} options.git
 * @param {() => Date} [options.ahora]
 * @param {number} [options.max]
 * @param {string} [options.dirIndices]
 */
export function createCheckpoints({
  git: executor,
  ahora = () => new Date(),
  max = MAX_CHECKPOINTS,
  dirIndices: dirIndexes,
}) {
  const { git } = /** @type {{ git: CheckpointGit }} */ (executor);
  /** @type {Map<string, { en: number, valor: RepositoryInfo }>} */
  const cacheInfo = new Map();

  /** @param {string} cwd */
  async function info(cwd) {
    const previous = cacheInfo.get(cwd);
    if (previous && Date.now() - previous.en < 30000) return previous.valor;
    const value = { esRepo: false, tieneRemoto: false, remotoGithub: false };
    const inside = await stat(path.join(cwd, ".git")).catch(
      /** @returns {null} */ () => null,
    );
    if (inside) {
      value.esRepo = true;
      const url = await git(cwd, ["config", "--get", "remote.origin.url"])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      value.tieneRemoto = !!url;
      value.remotoGithub = /(^|[@/.])github\.com[:/]/i.test(url);
    }
    cacheInfo.set(cwd, { en: Date.now(), valor: value });
    return value;
  }

  /** @param {string} cwd */
  const hasHead = (cwd) =>
    git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).then(
      () => true,
      () => false,
    );

  /** @template T @param {(env: { GIT_INDEX_FILE: string }) => Promise<T>} fn */
  async function withTemporaryIndex(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-idx-"));
    try {
      return await fn({ GIT_INDEX_FILE: path.join(dir, "index") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Seeding from HEAD keeps tracked files (even ignored ones) and lets
  // `add -A` register deletions.
  /** @param {string} cwd @param {{ GIT_INDEX_FILE: string }} env @param {boolean} seed */
  async function seedAndWrite(cwd, env, seed) {
    if (seed && (await hasHead(cwd)))
      await git(cwd, ["read-tree", "HEAD"], { env });
    await git(cwd, ["add", "-A", "--", "."], { env, timeout: 120000 });
    return (await git(cwd, ["write-tree"], { env })).stdout.trim();
  }

  /** @type {Map<string, Promise<unknown>>} */
  const queuesRepo = new Map();
  /**
   * One index per repository: two sessions in one folder never share a write.
   * @template T
   * @param {string} cwd
   * @param {() => Promise<T>} fn
   */
  function inRepo(cwd, fn) {
    const next = (queuesRepo.get(cwd) ?? Promise.resolve()).then(fn);
    const clean = next.catch(() => {});
    queuesRepo.set(cwd, clean);
    clean.then(() => queuesRepo.get(cwd) === clean && queuesRepo.delete(cwd));
    return next;
  }

  /**
   * Tree id of the whole working tree: tracked and untracked, honouring .gitignore.
   * With `dirIndices` the private index outlives the call, so git's stat cache
   * only rehashes what changed: a turn in a large repo no longer reads every
   * file. A new HEAD (a commit, a checkout) seeds it again.
   * @param {string} cwd
   */
  function currentTree(cwd) {
    if (!dirIndexes)
      return withTemporaryIndex((env) => seedAndWrite(cwd, env, true));
    return inRepo(cwd, async () => {
      const name = createHash("sha256").update(cwd).digest("hex").slice(0, 32);
      const indice = path.join(dirIndexes, name + ".index");
      const mark = indice + ".head";
      const env = { GIT_INDEX_FILE: indice };
      const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      await mkdir(dirIndexes, { recursive: true, mode: 0o700 });
      const previous = await readFile(mark, "utf8").catch(
        /** @returns {null} */ () => null,
      );
      const current =
        previous === head &&
        (await stat(indice).catch(/** @returns {null} */ () => null));
      try {
        if (!current) {
          await rm(indice, { force: true });
          await rm(mark, { force: true });
        }
        const tree = await seedAndWrite(cwd, env, !current);
        if (!current) await writeFile(mark, head, { mode: 0o600 });
        return tree;
      } catch (error) {
        // A damaged cached index costs one slow capture, never a checkpoint.
        await rm(indice, { force: true });
        await rm(mark, { force: true });
        if (!current) throw error;
        return withTemporaryIndex((tmp) => seedAndWrite(cwd, tmp, true));
      }
    });
  }

  /**
   * Adds a checkpoint to `lista` and returns the new bounded list. An unchanged
   * tree reuses the previous commit: only the entry is new.
   * @param {string} cwd
   * @param {string} sessionId
   * @param {readonly SessionCheckpoint[]} lista
   * @param {unknown} message
   * @param {CheckpointMetadata} [extra]
   */
  async function capture(cwd, sessionId, lista, message, extra = {}) {
    const arbol = await currentTree(cwd);
    const last = lista.at(-1);
    const n = (last?.n ?? 0) + 1;
    let commit;
    if (last && last.arbol === arbol && last.commit) commit = last.commit;
    else {
      const parent = (await hasHead(cwd)) ? ["-p", "HEAD"] : [];
      commit = (
        await git(
          cwd,
          [
            "commit-tree",
            arbol,
            ...parent,
            "-m",
            `checkpoint ${sessionId} ${n}`,
          ],
          { env: IDENTITY },
        )
      ).stdout.trim();
    }
    await git(cwd, ["update-ref", refOf(sessionId, n), commit]);
    const created = [
      ...lista,
      {
        n,
        commit,
        arbol,
        ts: ahora().toISOString(),
        mensaje: plain(message),
        ...extra,
      },
    ];
    const old = created.splice(0, Math.max(0, created.length - max));
    for (const v of old)
      await git(cwd, ["update-ref", "-d", refOf(sessionId, v.n)]).catch(
        () => {},
      );
    return created;
  }

  /** @param {string} cwd @param {string} sessionId */
  async function deleteAll(cwd, sessionId) {
    const { stdout } = await git(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/secondbrain/checkpoints/${sessionId}/`,
    ]).catch(() => ({ stdout: "" }));
    for (const ref of stdout.split("\n").filter(Boolean))
      await git(cwd, ["update-ref", "-d", ref]).catch(() => {});
  }

  /** @param {string} cwd @param {string} file */
  async function removeEmpty(cwd, file) {
    let dir = path.dirname(file);
    while (dir.startsWith(cwd + path.sep) && dir !== cwd) {
      if ((await readdir(dir).catch(() => [1])).length) return;
      await rmdir(dir).catch(() => {});
      dir = path.dirname(dir);
    }
  }

  /**
   * Puts the working tree back as it was at `commit`: files of the checkpoint
   * return to their content and unignored files created later disappear.
   * HEAD, the branch and the index are not touched.
   * @param {string} cwd
   * @param {string} commit
   */
  async function restore(cwd, commit) {
    const goal = (
      await git(cwd, ["rev-parse", `${commit}^{tree}`])
    ).stdout.trim();
    const actual = await currentTree(cwd);
    const { stdout } = await git(cwd, [
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      goal,
      actual,
    ]);
    for (const relative of stdout.split("\0").filter(Boolean)) {
      const file = path.resolve(cwd, relative);
      if (!file.startsWith(cwd + path.sep)) continue;
      await rm(file, { recursive: true, force: true });
      await removeEmpty(cwd, file);
    }
    await withTemporaryIndex(async (env) => {
      await git(cwd, ["read-tree", goal], { env });
      await git(cwd, ["checkout-index", "-a", "-f"], { env, timeout: 120000 });
    });
  }

  /** @param {string} output */
  function analyzeStates(output) {
    const parts = output.split("\0");
    const list = [];
    for (let i = 0; i < parts.length - 1;) {
      const state = parts[i++];
      if (!state) continue;
      if (state[0] === "R" || state[0] === "C")
        list.push({ estado: "R", anterior: parts[i++], ruta: parts[i++] });
      else list.push({ estado: state[0], ruta: parts[i++] });
    }
    return list;
  }
  /** @param {string} output */
  function analyzeNumbers(output) {
    const parts = output.split("\0");
    /** @type {Map<string, { binario: boolean, añadidas: number, eliminadas: number }>} */
    const map = new Map();
    for (let i = 0; i < parts.length;) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i++] ?? "");
      if (!m) continue;
      let ruta = m[3];
      if (!ruta) {
        i++; // rename: the previous path, then the new one
        ruta = parts[i++];
      }
      map.set(ruta, {
        binario: m[1] === "-",
        añadidas: m[1] === "-" ? 0 : Number(m[1]),
        eliminadas: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
    return map;
  }

  /**
   * Changes between two tree-ish values: file summary plus a bounded unified patch.
   * @param {string} cwd
   * @param {string} from
   * @param {string} until
   */
  async function diff(cwd, from, until) {
    const base = [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-M",
    ];
    const [states, numbers, parche] = await Promise.all([
      git(cwd, [...base, "--name-status", "-z", from, until]),
      git(cwd, [...base, "--numstat", "-z", from, until]),
      git(cwd, [...base, "--patch", from, until], {
        max: MAX_PATCH * 4,
        tolerarExceso: true,
      }),
    ]);
    const digits = analyzeNumbers(numbers.stdout);
    const files = analyzeStates(states.stdout).map((a) => ({
      ruta: a.ruta,
      ...(a.anterior ? { anterior: a.anterior } : {}),
      estado: a.estado,
      añadidas: digits.get(a.ruta)?.añadidas ?? 0,
      eliminadas: digits.get(a.ruta)?.eliminadas ?? 0,
      binario: digits.get(a.ruta)?.binario ?? false,
    }));
    let text = parche.stdout;
    let trimmed = !!parche.excedido;
    if (text.length > MAX_PATCH) {
      trimmed = true;
      text = text.slice(0, MAX_PATCH);
    }
    if (trimmed) text = text.slice(0, text.lastIndexOf("\n") + 1);
    return { archivos: files, parche: text, recortado: trimmed };
  }

  return {
    info,
    arbolActual: currentTree,
    capturar: capture,
    restaurar: restore,
    borrarTodos: deleteAll,
    diff,
  };
}

/**
 * Keeps each session's checkpoint list: captures before a turn, reverts and
 * diffs. A failing capture is recorded and never blocks the turn.
 * @param {object} options
 * @param {Pick<SessionRegistry, "leer" | "actualizar">} options.registro
 * @param {ReturnType<typeof createCheckpoints>} options.checkpoints
 * @param {(session: Readonly<LauncherSession>) => string | null | undefined} options.cwdDe
 */
export function createTracking({
  registro: registry,
  checkpoints,
  cwdDe: cwdOf,
}) {
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();
  /** @template T @param {string} id @param {() => Promise<T>} fn */
  function serial(id, fn) {
    const next = (queues.get(id) ?? Promise.resolve()).then(fn);
    const clean = next.catch(() => {});
    queues.set(id, clean);
    clean.then(() => queues.get(id) === clean && queues.delete(id));
    return next;
  }
  /** @param {string} id */
  const buscar = (id) =>
    registry.leer().find((s) => s.id === id && !s.eliminada);

  /** @param {string} id @param {unknown} message @param {CheckpointMetadata} [extra] */
  async function captureSession(id, message, extra) {
    const session = buscar(id);
    const cwd = session && cwdOf(session);
    if (!cwd || !(await checkpoints.info(cwd)).esRepo) return null;
    const list = await checkpoints.capturar(
      cwd,
      id,
      session.checkpoints ?? [],
      message,
      extra,
    );
    await registry.actualizar(id, {
      checkpoints: list,
      checkpointError: null,
    });
    return list.at(-1);
  }

  return {
    /**
     * Before a turn. Resolves even on failure, so the turn always goes on.
     * @param {string} id
     * @param {unknown} message
     */
    marcar(id, message) {
      return serial(id, async () => {
        try {
          return await captureSession(id, message);
        } catch {
          await registry
            .actualizar(id, {
              checkpointError: "No se pudo guardar el punto de control.",
            })
            .catch(() => {});
          return null;
        }
      });
    },
    /** @param {string} id @param {number} n */
    revertir(id, n) {
      return serial(id, async () => {
        const session = buscar(id);
        const cwd = session && cwdOf(session);
        const target = session?.checkpoints?.find((c) => c.n === n);
        if (!target)
          throw new LauncherError("Ese punto de control ya no existe.", 404);
        // The safety checkpoint is what «undo» goes back to.
        let security;
        try {
          security = await captureSession(
            id,
            `Antes de revertir al turno ${n}`,
            { tipo: "reversion", de: n },
          );
          if (!cwd) throw new Error("No hay un directorio de sesión.");
          await checkpoints.restaurar(cwd, target.commit);
        } catch {
          throw new LauncherError(
            "No se pudo restaurar el árbol de trabajo. Revisa el repositorio.",
            500,
          );
        }
        return { revertido: n, seguridad: security?.n ?? null };
      });
    },
    /** @param {string} id @param {number} [from] @param {number | "actual"} [until] */
    async diff(id, from, until) {
      const session = buscar(id);
      const cwd = session && cwdOf(session);
      const list = session?.checkpoints ?? [];
      if (!cwd || !list.length)
        throw new LauncherError("Esta sesión no tiene puntos de control.", 404);
      /** @param {number} n */
      const point = (n) => {
        const c = list.find((x) => x.n === n);
        if (!c)
          throw new LauncherError("Ese punto de control ya no existe.", 404);
        return c.commit;
      };
      const a = from === undefined ? list[0].commit : point(from);
      const b =
        until === undefined || until === "actual"
          ? await checkpoints.arbolActual(cwd)
          : point(until);
      return checkpoints.diff(cwd, a, b);
    },
    /** @param {string} id @param {string | null | undefined} cwd */
    async borrar(id, cwd) {
      if (cwd) await checkpoints.borrarTodos(cwd, id);
    },
  };
}
