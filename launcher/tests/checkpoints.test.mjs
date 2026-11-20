import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGit } from "../git.mjs";
import {
  MAX_CHECKPOINTS,
  createCheckpoints,
  createTracking,
} from "../checkpoints.mjs";
import { openSessionRegistry } from "../sessions.mjs";
import { createExecutor } from "../executor.mjs";
import { git, repoSintetico } from "./helpers-git.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const cp = (max) => createCheckpoints({ git: createGit(), max });
const read = (cwd, file) => readFile(path.join(cwd, file), "utf8");
const existe = (cwd, file) =>
  stat(path.join(cwd, file)).then(
    () => true,
    () => false,
  );

test("restaura archivos modificados, nuevos y borrados sin tocar índice, rama ni ignorados", async (t) => {
  const cwd = await repoSintetico(t);
  const c = cp();
  await writeFile(path.join(cwd, "ignorado.log"), "log v1\n");
  await writeFile(path.join(cwd, "sin-seguir.txt"), "antes\n");
  git(cwd, "add", "b.txt"); // staged on purpose: must stay staged
  const cabeza = git(cwd, "rev-parse", "HEAD");
  const index = git(cwd, "ls-files", "-s");
  const lista = await c.capturar(cwd, "s1", [], "primer turno");
  assert.equal(lista.length, 1);

  // The agent edits, creates and deletes files.
  await writeFile(path.join(cwd, "a.txt"), "uno cambiado\n");
  await writeFile(path.join(cwd, "nuevo.txt"), "nuevo\n");
  await mkdir(path.join(cwd, "carpeta/sub"), { recursive: true });
  await writeFile(path.join(cwd, "carpeta/sub/x.txt"), "x\n");
  await rm(path.join(cwd, "sin-seguir.txt"));
  await rm(path.join(cwd, "b.txt"));
  await writeFile(path.join(cwd, "ignorado.log"), "log v2\n");

  const indexBefore = git(cwd, "ls-files", "-s");
  await c.restaurar(cwd, lista[0].commit);

  assert.equal(await read(cwd, "a.txt"), "uno\n");
  assert.equal(await read(cwd, "b.txt"), "dos\n");
  assert.equal(await read(cwd, "sin-seguir.txt"), "antes\n");
  assert.equal(await existe(cwd, "nuevo.txt"), false);
  assert.equal(await existe(cwd, "carpeta"), false);
  // Ignored files are not part of a checkpoint: left exactly as they were.
  assert.equal(await read(cwd, "ignorado.log"), "log v2\n");
  assert.equal(git(cwd, "rev-parse", "HEAD"), cabeza);
  assert.equal(git(cwd, "branch", "--show-current"), "main");
  assert.equal(git(cwd, "ls-files", "-s"), indexBefore);
  assert.notEqual(index, "");
  assert.equal(git(cwd, "stash", "list"), "");
  assert.ok(git(cwd, "for-each-ref", "refs/secondbrain/").includes("/s1/1"));
});

test("un árbol idéntico reutiliza el commit y la lista se poda al límite (50 por defecto) con sus refs", async (t) => {
  const cwd = await repoSintetico(t);
  assert.equal(MAX_CHECKPOINTS, 50);
  const c = cp(5);
  let list = await c.capturar(cwd, "s2", [], "uno");
  list = await c.capturar(cwd, "s2", list, "dos");
  assert.equal(list[0].commit, list[1].commit);
  assert.deepEqual(
    list.map((x) => x.n),
    [1, 2],
  );
  assert.equal(list[1].mensaje, "dos");
  await writeFile(path.join(cwd, "a.txt"), "otro\n");
  list = await c.capturar(cwd, "s2", list, "x".repeat(300));
  assert.notEqual(list[2].commit, list[1].commit);
  assert.equal(list[2].mensaje.length, 120);
  for (let i = 0; i < 8; i++) {
    await writeFile(path.join(cwd, "a.txt"), `v${i}\n`);
    list = await c.capturar(cwd, "s2", list, `turno ${i}`);
  }
  assert.equal(list.length, 5);
  assert.equal(list.at(-1).n, 11);
  const refs = git(
    cwd,
    "for-each-ref",
    "--format=%(refname)",
    "refs/secondbrain/",
  )
    .split("\n")
    .filter(Boolean);
  assert.equal(refs.length, 5);
  assert.ok(!refs.includes("refs/secondbrain/checkpoints/s2/1"));
  await c.borrarTodos(cwd, "s2");
  assert.equal(git(cwd, "for-each-ref", "refs/secondbrain/"), "");
});

test("funciona en un repositorio sin commits y no altera el árbol", async (t) => {
  const cwd = await repoSintetico(t, { commit: false });
  const c = cp();
  const list = await c.capturar(cwd, "s3", [], "inicio");
  assert.equal(
    git(cwd, "cat-file", "-p", list[0].commit).includes("parent"),
    false,
  );
  await writeFile(path.join(cwd, "a.txt"), "cambio\n");
  await c.restaurar(cwd, list[0].commit);
  assert.equal(await read(cwd, "a.txt"), "uno\n");
  assert.equal(git(cwd, "status", "--porcelain").includes("a.txt"), true);
});

test("el diff resume archivos, renombrados y binarios, y recorta el parche", async (t) => {
  const cwd = await repoSintetico(t);
  const c = cp();
  const list = await c.capturar(cwd, "s4", [], "base");
  await writeFile(path.join(cwd, "a.txt"), "uno\ndos\ntres\n");
  await rm(path.join(cwd, "b.txt"));
  await writeFile(path.join(cwd, "nuevo.txt"), "hola\n");
  await writeFile(path.join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
  const actual = await c.arbolActual(cwd);
  const d = await c.diff(cwd, list[0].commit, actual);
  const por = Object.fromEntries(d.archivos.map((a) => [a.ruta, a]));
  assert.deepEqual(
    [por["a.txt"].estado, por["a.txt"].añadidas, por["a.txt"].eliminadas],
    ["M", 2, 0],
  );
  assert.equal(por["b.txt"].estado, "D");
  assert.equal(por["nuevo.txt"].estado, "A");
  assert.equal(por["bin.dat"].binario, true);
  assert.match(d.parche, /^@@ /m);
  assert.equal(d.recortado, false);

  // A huge change is trimmed to 1 MB on a line boundary.
  await writeFile(
    path.join(cwd, "grande.txt"),
    Array.from(
      { length: 60000 },
      (_, i) => `linea numero ${i} con relleno`,
    ).join("\n"),
  );
  const grande = await c.diff(cwd, list[0].commit, await c.arbolActual(cwd));
  assert.equal(grande.recortado, true);
  assert.ok(grande.parche.length <= 1024 * 1024);
  assert.ok(grande.parche.endsWith("\n"));
});

test("el seguimiento revierte un turno, guarda un punto de seguridad y permite deshacer", async (t) => {
  const cwd = await repoSintetico(t);
  const dir = await mkdtemp(path.join(tmpdir(), "sb-seg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const session = await registry.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "p",
    encargo: "tarea",
    directorio: cwd,
  });
  const tracking = createTracking({
    registro: registry,
    checkpoints: cp(),
    cwdDe: (s) => s.directorio,
  });
  await tracking.marcar(session.id, "turno uno");
  await writeFile(path.join(cwd, "a.txt"), "turno uno hecho\n");
  await tracking.marcar(session.id, "turno dos");
  await writeFile(path.join(cwd, "a.txt"), "turno dos hecho\n");
  await writeFile(path.join(cwd, "creado.txt"), "x\n");

  const byTurn = await tracking.diff(session.id, 2, "actual");
  assert.deepEqual(byTurn.archivos.map((a) => a.ruta).sort(), [
    "a.txt",
    "creado.txt",
  ]);
  const complete = await tracking.diff(session.id);
  assert.equal(complete.archivos.length, 2);

  const r = await tracking.revertir(session.id, 2);
  assert.equal(r.revertido, 2);
  assert.equal(await read(cwd, "a.txt"), "turno uno hecho\n");
  assert.equal(await existe(cwd, "creado.txt"), false);
  const list = registry.leer()[0].checkpoints;
  assert.equal(list.at(-1).tipo, "reversion");
  assert.equal(list.at(-1).n, r.seguridad);

  // Undo: back to the safety checkpoint.
  await tracking.revertir(session.id, r.seguridad);
  assert.equal(await read(cwd, "a.txt"), "turno dos hecho\n");
  assert.equal(await read(cwd, "creado.txt"), "x\n");
  await assert.rejects(tracking.revertir(session.id, 99), /ya no existe/);
});

test("un fallo al capturar se registra y no aborta; fuera de un repo no hace nada", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-seg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const plain = await registry.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "p",
    encargo: "t",
    directorio: dir,
  });
  const fake = {
    info: async () => ({ esRepo: true }),
    capturar: async () => {
      throw new Error("boom");
    },
  };
  const tracking = createTracking({
    registro: registry,
    checkpoints: fake,
    cwdDe: (s) => s.directorio,
  });
  assert.equal(await tracking.marcar(plain.id, "x"), null);
  assert.match(registry.leer()[0].checkpointError, /punto de control/);
  const withoutRepo = createTracking({
    registro: registry,
    checkpoints: cp(),
    cwdDe: (s) => s.directorio,
  });
  assert.equal(await withoutRepo.marcar(plain.id, "x"), null);
  assert.equal(registry.leer()[0].checkpoints, undefined);
});

test("el ejecutor guarda un punto de control antes de cada turno y borra las refs al eliminar", async (t) => {
  const cwd = await repoSintetico(t);
  const dir = await mkdtemp(path.join(tmpdir(), "sb-ej-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const falso = path.join(dir, "falso.mjs");
  // The fake engine edits a file: the checkpoint must hold the state before that.
  await writeFile(
    falso,
    `import { writeFileSync } from "node:fs";
writeFileSync("a.txt", "editado por el agente");
console.log(JSON.stringify({ type: "result", session_id: "conv", result: "ok" }));`,
  );
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const tracking = createTracking({
    registro: registry,
    checkpoints: cp(),
    cwdDe: (s) => s.directorio || null,
  });
  const executor = createExecutor({
    registro: registry,
    proyectos: { repo: cwd },
    seguimiento: tracking,
    comando: () => ({ bin: process.execPath, args: [falso] }),
  });
  const s = await executor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "repo",
    brief: "primer turno",
  });
  await executor.esperar(s.id);
  let session = registry.leer().find((x) => x.id === s.id);
  assert.equal(session.estado, "terminada");
  assert.equal(session.checkpoints.length, 1);
  assert.equal(session.checkpoints[0].mensaje, "primer turno");
  assert.equal(await read(cwd, "a.txt"), "editado por el agente");
  // The captured tree still has the original file.
  assert.equal(
    git(cwd, "show", `${session.checkpoints[0].commit}:a.txt`),
    "uno",
  );
  await executor.continuar(s.id, "segundo turno");
  await executor.esperar(s.id);
  session = registry.leer().find((x) => x.id === s.id);
  assert.deepEqual(
    session.checkpoints.map((c) => c.mensaje),
    ["primer turno", "segundo turno"],
  );
  assert.ok(git(cwd, "for-each-ref", "refs/secondbrain/").includes(s.id));
  await executor.eliminar(s.id);
  assert.equal(git(cwd, "for-each-ref", "refs/secondbrain/"), "");
  assert.equal(
    registry.leer().find((x) => x.id === s.id).checkpoints,
    undefined,
  );
});

test("el índice persistente da el mismo árbol que uno temporal y se resiembra con un HEAD nuevo", async (t) => {
  const cwd = await repoSintetico(t);
  const dirIndexes = await mkdtemp(path.join(tmpdir(), "sb-idx-"));
  t.after(() => rm(dirIndexes, { recursive: true, force: true }));
  const rapido = createCheckpoints({
    git: createGit(),
    dirIndices: dirIndexes,
  });
  const temporary = cp();
  const igual = async (message) =>
    assert.equal(
      await rapido.arbolActual(cwd),
      await temporary.arbolActual(cwd),
      message,
    );
  await igual("árbol inicial");
  await writeFile(path.join(cwd, "a.txt"), "uno cambiado\n");
  await writeFile(path.join(cwd, "nuevo.txt"), "nuevo\n");
  await rm(path.join(cwd, "b.txt"));
  await igual("modificar, crear y borrar");
  // A file that becomes tracked and ignored through a new commit.
  await writeFile(path.join(cwd, "ignorado.log"), "seguido\n");
  git(cwd, "add", "-f", "ignorado.log");
  git(cwd, "commit", "-q", "-m", "chore: seguir log");
  await igual("HEAD nuevo");
  await rm(path.join(cwd, "ignorado.log"));
  await igual("borrar un archivo seguido e ignorado");
  // Two captures at once in the same folder do not corrupt the shared index.
  const [x, y] = await Promise.all([
    rapido.arbolActual(cwd),
    rapido.arbolActual(cwd),
  ]);
  assert.equal(x, y);
  // A damaged cached index costs one slow capture, never a checkpoint.
  const { readdir } = await import("node:fs/promises");
  const [indice] = (await readdir(dirIndexes)).filter((n) =>
    n.endsWith(".index"),
  );
  await writeFile(path.join(dirIndexes, indice), "basura");
  await igual("índice dañado");
});

test("un Enter tecleado en la terminal con el agente en espera guarda un punto de control antes de llegar al programa", async (t) => {
  const cwd = await repoSintetico(t);
  const dir = await mkdtemp(path.join(tmpdir(), "sb-tecla-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const tracking = createTracking({
    registro: registry,
    checkpoints: cp(),
    cwdDe: (s) => s.directorio || null,
  });
  const escrito = [];
  let child;
  const executor = createExecutor({
    registro: registry,
    proyectos: { repo: cwd },
    seguimiento: tracking,
    env: { PATH: process.env.PATH, HOME: dir },
    comandoInteractivo: () => ({ bin: "falso", args: [] }),
    lanzarPty: () => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on("data", (part) => {
        for (const line of part.toString().split("\n"))
          if (line) {
            const value = JSON.parse(line);
            // What the checkpoint list held when the key reached the program.
            const n = registry.leer()[0]?.checkpoints?.length ?? 0;
            escrito.push({ ...value, checkpoints: n });
          }
      });
      child.kill = () =>
        setTimeout(() => {
          child.stdout.end();
          child.emit("close", 0);
        }, 20);
      return child;
    },
  });
  const s = await executor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "repo",
    harness: true,
    brief: "hola",
  });
  t.after(async () => {
    if (executor.activos()) {
      await executor.cancelar(s.id);
      await executor.esperar(s.id);
    }
  });
  for (let i = 0; i < 200 && !child; i++)
    await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 200; i++) {
    if (registry.leer()[0]?.checkpoints?.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const initial = registry.leer()[0].checkpoints.length;
  await registry.actualizar(s.id, { estado: "terminada" });
  // Typed key by key, with a typo fixed by Backspace, then Enter.
  for (const raw of ["r", "e", "x", "\x7f", "v", "i", "s", "a", "\r"])
    executor.entrada(s.id, { raw });
  // While the agent works, Enter answers a menu: no new checkpoint.
  for (let i = 0; i < 300 && escrito.length < 9; i++)
    await new Promise((r) => setTimeout(r, 10));
  await registry.actualizar(s.id, { estado: "trabajando" });
  executor.entrada(s.id, { raw: "\r" });
  for (let i = 0; i < 300 && escrito.length < 10; i++)
    await new Promise((r) => setTimeout(r, 10));
  const lista = registry.leer()[0].checkpoints;
  assert.equal(lista.length, initial + 1);
  assert.equal(lista.at(-1).mensaje, "revisa");
  // Keys arrive in order, and the Enter only after its checkpoint exists.
  assert.deepEqual(
    escrito.slice(-10).map((e) => e.raw),
    ["r", "e", "x", "\x7f", "v", "i", "s", "a", "\r", "\r"],
  );
  assert.equal(escrito.at(-2).checkpoints, initial + 1);
});
