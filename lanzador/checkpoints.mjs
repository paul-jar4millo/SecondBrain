// @ts-check
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
import { ErrorLanzador } from "./errores.mjs";

export const MAX_CHECKPOINTS = 50;
export const MAX_PARCHE = 1024 * 1024;
const MENSAJE = 120;
const IDENTIDAD = {
  GIT_AUTHOR_NAME: "SecondBrain",
  GIT_AUTHOR_EMAIL: "checkpoint@secondbrain.invalid",
  GIT_COMMITTER_NAME: "SecondBrain",
  GIT_COMMITTER_EMAIL: "checkpoint@secondbrain.invalid",
};
const refDe = (id, n) => `refs/secondbrain/checkpoints/${id}/${n}`;
const plano = (texto) =>
  String(texto ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MENSAJE);

/**
 * Checkpoints of a working tree as hidden refs. Nothing here touches the user's
 * index, branch, stash or HEAD: trees are built in a throwaway index file.
 */
export function crearCheckpoints({
  git: ejecutor,
  ahora = () => new Date(),
  max = MAX_CHECKPOINTS,
  dirIndices,
}) {
  const { git } = ejecutor;
  const cacheInfo = new Map();

  async function info(cwd) {
    const previo = cacheInfo.get(cwd);
    if (previo && Date.now() - previo.en < 30000) return previo.valor;
    const valor = { esRepo: false, tieneRemoto: false, remotoGithub: false };
    const dentro = await stat(path.join(cwd, ".git")).catch(() => null);
    if (dentro) {
      valor.esRepo = true;
      const url = await git(cwd, ["config", "--get", "remote.origin.url"])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      valor.tieneRemoto = !!url;
      valor.remotoGithub = /(^|[@/.])github\.com[:/]/i.test(url);
    }
    cacheInfo.set(cwd, { en: Date.now(), valor });
    return valor;
  }

  const tieneHead = (cwd) =>
    git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).then(
      () => true,
      () => false,
    );

  async function conIndiceTemporal(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-idx-"));
    try {
      return await fn({ GIT_INDEX_FILE: path.join(dir, "index") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Seeding from HEAD keeps tracked files (even ignored ones) and lets
  // `add -A` register deletions.
  async function sembrarYEscribir(cwd, env, sembrar) {
    if (sembrar && (await tieneHead(cwd)))
      await git(cwd, ["read-tree", "HEAD"], { env });
    await git(cwd, ["add", "-A", "--", "."], { env, timeout: 120000 });
    return (await git(cwd, ["write-tree"], { env })).stdout.trim();
  }

  const colasRepo = new Map();
  /** One index per repository: two sessions in one folder never share a write. */
  function enRepo(cwd, fn) {
    const siguiente = (colasRepo.get(cwd) ?? Promise.resolve()).then(fn);
    const limpio = siguiente.catch(() => {});
    colasRepo.set(cwd, limpio);
    limpio.then(() => colasRepo.get(cwd) === limpio && colasRepo.delete(cwd));
    return siguiente;
  }

  /**
   * Tree id of the whole working tree: tracked and untracked, honouring .gitignore.
   * With `dirIndices` the private index outlives the call, so git's stat cache
   * only rehashes what changed: a turn in a large repo no longer reads every
   * file. A new HEAD (a commit, a checkout) seeds it again.
   */
  function arbolActual(cwd) {
    if (!dirIndices)
      return conIndiceTemporal((env) => sembrarYEscribir(cwd, env, true));
    return enRepo(cwd, async () => {
      const nombre = createHash("sha256")
        .update(cwd)
        .digest("hex")
        .slice(0, 32);
      const indice = path.join(dirIndices, nombre + ".index");
      const marca = indice + ".head";
      const env = { GIT_INDEX_FILE: indice };
      const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      await mkdir(dirIndices, { recursive: true, mode: 0o700 });
      const previa = await readFile(marca, "utf8").catch(() => null);
      const vigente = previa === head && (await stat(indice).catch(() => null));
      try {
        if (!vigente) {
          await rm(indice, { force: true });
          await rm(marca, { force: true });
        }
        const arbol = await sembrarYEscribir(cwd, env, !vigente);
        if (!vigente) await writeFile(marca, head, { mode: 0o600 });
        return arbol;
      } catch (error) {
        // A damaged cached index costs one slow capture, never a checkpoint.
        await rm(indice, { force: true });
        await rm(marca, { force: true });
        if (!vigente) throw error;
        return conIndiceTemporal((tmp) => sembrarYEscribir(cwd, tmp, true));
      }
    });
  }

  /**
   * Adds a checkpoint to `lista` and returns the new bounded list. An unchanged
   * tree reuses the previous commit: only the entry is new.
   */
  async function capturar(cwd, sesionId, lista, mensaje, extra = {}) {
    const arbol = await arbolActual(cwd);
    const ultimo = lista.at(-1);
    const n = (ultimo?.n ?? 0) + 1;
    let commit;
    if (ultimo?.arbol === arbol && ultimo.commit) commit = ultimo.commit;
    else {
      const padre = (await tieneHead(cwd)) ? ["-p", "HEAD"] : [];
      commit = (
        await git(
          cwd,
          ["commit-tree", arbol, ...padre, "-m", `checkpoint ${sesionId} ${n}`],
          { env: IDENTIDAD },
        )
      ).stdout.trim();
    }
    await git(cwd, ["update-ref", refDe(sesionId, n), commit]);
    const nueva = [
      ...lista,
      {
        n,
        commit,
        arbol,
        ts: ahora().toISOString(),
        mensaje: plano(mensaje),
        ...extra,
      },
    ];
    const viejas = nueva.splice(0, Math.max(0, nueva.length - max));
    for (const v of viejas)
      await git(cwd, ["update-ref", "-d", refDe(sesionId, v.n)]).catch(
        () => {},
      );
    return nueva;
  }

  async function borrarTodos(cwd, sesionId) {
    const { stdout } = await git(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/secondbrain/checkpoints/${sesionId}/`,
    ]).catch(() => ({ stdout: "" }));
    for (const ref of stdout.split("\n").filter(Boolean))
      await git(cwd, ["update-ref", "-d", ref]).catch(() => {});
  }

  async function quitarVacios(cwd, archivo) {
    let dir = path.dirname(archivo);
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
   */
  async function restaurar(cwd, commit) {
    const objetivo = (
      await git(cwd, ["rev-parse", `${commit}^{tree}`])
    ).stdout.trim();
    const actual = await arbolActual(cwd);
    const { stdout } = await git(cwd, [
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      objetivo,
      actual,
    ]);
    for (const relativa of stdout.split("\0").filter(Boolean)) {
      const archivo = path.resolve(cwd, relativa);
      if (!archivo.startsWith(cwd + path.sep)) continue;
      await rm(archivo, { recursive: true, force: true });
      await quitarVacios(cwd, archivo);
    }
    await conIndiceTemporal(async (env) => {
      await git(cwd, ["read-tree", objetivo], { env });
      await git(cwd, ["checkout-index", "-a", "-f"], { env, timeout: 120000 });
    });
  }

  function analizarEstados(salida) {
    const partes = salida.split("\0");
    const lista = [];
    for (let i = 0; i < partes.length - 1;) {
      const estado = partes[i++];
      if (!estado) continue;
      if (estado[0] === "R" || estado[0] === "C")
        lista.push({ estado: "R", anterior: partes[i++], ruta: partes[i++] });
      else lista.push({ estado: estado[0], ruta: partes[i++] });
    }
    return lista;
  }
  function analizarNumeros(salida) {
    const partes = salida.split("\0");
    const mapa = new Map();
    for (let i = 0; i < partes.length;) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(partes[i++] ?? "");
      if (!m) continue;
      let ruta = m[3];
      if (!ruta) {
        i++; // rename: the previous path, then the new one
        ruta = partes[i++];
      }
      mapa.set(ruta, {
        binario: m[1] === "-",
        añadidas: m[1] === "-" ? 0 : Number(m[1]),
        eliminadas: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
    return mapa;
  }

  /** Changes between two tree-ish values: file summary plus a bounded unified patch. */
  async function diff(cwd, desde, hasta) {
    const base = [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-M",
    ];
    const [estados, numeros, parche] = await Promise.all([
      git(cwd, [...base, "--name-status", "-z", desde, hasta]),
      git(cwd, [...base, "--numstat", "-z", desde, hasta]),
      git(cwd, [...base, "--patch", desde, hasta], {
        max: MAX_PARCHE * 4,
        tolerarExceso: true,
      }),
    ]);
    const cifras = analizarNumeros(numeros.stdout);
    const archivos = analizarEstados(estados.stdout).map((a) => ({
      ruta: a.ruta,
      ...(a.anterior ? { anterior: a.anterior } : {}),
      estado: a.estado,
      añadidas: cifras.get(a.ruta)?.añadidas ?? 0,
      eliminadas: cifras.get(a.ruta)?.eliminadas ?? 0,
      binario: cifras.get(a.ruta)?.binario ?? false,
    }));
    let texto = parche.stdout;
    let recortado = !!parche.excedido;
    if (texto.length > MAX_PARCHE) {
      recortado = true;
      texto = texto.slice(0, MAX_PARCHE);
    }
    if (recortado) texto = texto.slice(0, texto.lastIndexOf("\n") + 1);
    return { archivos, parche: texto, recortado };
  }

  return { info, arbolActual, capturar, restaurar, borrarTodos, diff };
}

/**
 * Keeps each session's checkpoint list: captures before a turn, reverts and
 * diffs. A failing capture is recorded and never blocks the turn.
 */
export function crearSeguimiento({ registro, checkpoints, cwdDe }) {
  const colas = new Map();
  function serial(id, fn) {
    const siguiente = (colas.get(id) ?? Promise.resolve()).then(fn);
    const limpio = siguiente.catch(() => {});
    colas.set(id, limpio);
    limpio.then(() => colas.get(id) === limpio && colas.delete(id));
    return siguiente;
  }
  const buscar = (id) =>
    registro.leer().find((s) => s.id === id && !s.eliminada);

  async function capturarSesion(id, mensaje, extra) {
    const sesion = buscar(id);
    const cwd = sesion && cwdDe(sesion);
    if (!cwd || !(await checkpoints.info(cwd)).esRepo) return null;
    const lista = await checkpoints.capturar(
      cwd,
      id,
      sesion.checkpoints ?? [],
      mensaje,
      extra,
    );
    await registro.actualizar(id, {
      checkpoints: lista,
      checkpointError: null,
    });
    return lista.at(-1);
  }

  return {
    /** Before a turn. Resolves even on failure, so the turn always goes on. */
    marcar(id, mensaje) {
      return serial(id, async () => {
        try {
          return await capturarSesion(id, mensaje);
        } catch {
          await registro
            .actualizar(id, {
              checkpointError: "No se pudo guardar el punto de control.",
            })
            .catch(() => {});
          return null;
        }
      });
    },
    revertir(id, n) {
      return serial(id, async () => {
        const sesion = buscar(id);
        const cwd = sesion && cwdDe(sesion);
        const destino = sesion?.checkpoints?.find((c) => c.n === n);
        if (!destino)
          throw new ErrorLanzador("Ese punto de control ya no existe.", 404);
        // The safety checkpoint is what «undo» goes back to.
        let seguridad;
        try {
          seguridad = await capturarSesion(
            id,
            `Antes de revertir al turno ${n}`,
            { tipo: "reversion", de: n },
          );
          await checkpoints.restaurar(cwd, destino.commit);
        } catch {
          throw new ErrorLanzador(
            "No se pudo restaurar el árbol de trabajo. Revisa el repositorio.",
            500,
          );
        }
        return { revertido: n, seguridad: seguridad?.n ?? null };
      });
    },
    async diff(id, desde, hasta) {
      const sesion = buscar(id);
      const cwd = sesion && cwdDe(sesion);
      const lista = sesion?.checkpoints ?? [];
      if (!lista.length)
        throw new ErrorLanzador("Esta sesión no tiene puntos de control.", 404);
      const punto = (n) => {
        const c = lista.find((x) => x.n === n);
        if (!c)
          throw new ErrorLanzador("Ese punto de control ya no existe.", 404);
        return c.commit;
      };
      const a = desde === undefined ? lista[0].commit : punto(desde);
      const b =
        hasta === undefined || hasta === "actual"
          ? await checkpoints.arbolActual(cwd)
          : punto(hasta);
      return checkpoints.diff(cwd, a, b);
    },
    async borrar(id, cwd) {
      if (cwd) await checkpoints.borrarTodos(cwd, id);
    },
  };
}
