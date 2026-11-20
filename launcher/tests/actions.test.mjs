import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLauncherServer } from "../index.mjs";
import { openSessionRegistry } from "../sessions.mjs";
import { createGit } from "../git.mjs";
import { createCheckpoints, createTracking } from "../checkpoints.mjs";
import { createPrClient, branchName, proposalPr, slug } from "../pr.mjs";
import { createActions } from "../actions.mjs";
import { CAPABILITIES, capabilitiesOf, economyModel } from "../engines.mjs";
import { git, repoSintetico } from "./helpers-git.mjs";

const fingerprint = (token) => createHash("sha256").update(token).digest("hex");

/** A gh that records its arguments and answers like the real one, with no network. */
async function ghFake(dir) {
  const file = path.join(dir, "gh-falso.mjs");
  const registry = path.join(dir, "gh-llamadas.jsonl");
  await writeFile(
    file,
    `import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(registry)}, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view") {
  if (existsSync(${JSON.stringify(path.join(dir, "pr-existente"))})) {
    console.log(JSON.stringify({ url: "https://github.com/test/repo/pull/3", state: "OPEN" }));
    process.exit(0);
  }
  console.error("no pull requests found");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/test/repo/pull/7");
  process.exit(0);
}
process.exit(2);
`,
  );
  return {
    comando: [process.execPath, file],
    llamadas: async () =>
      (await readFile(registry, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

async function environment(
  t,
  { remoto = true, motor: engine = "claude", estado: state } = {},
) {
  const cwd = await repoSintetico(t);
  const dir = await mkdtemp(path.join(tmpdir(), "sb-acc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (remoto) {
    const bare = path.join(dir, "remoto.git");
    git(dir, "init", "-q", "--bare", "-b", "main", bare);
    // The URL says GitHub; the rewrite sends the data to the local bare repo.
    git(cwd, "remote", "add", "origin", "https://github.com/test/repo.git");
    git(
      cwd,
      "config",
      `url.${bare.replaceAll("\\", "/")}.insteadOf`,
      "https://github.com/test/repo.git",
    );
    git(cwd, "push", "-q", "-u", "origin", "main");
  }
  const gh = await ghFake(dir);
  const gitExecutor = createGit({ ghComando: gh.comando });
  const checkpoints = createCheckpoints({ git: gitExecutor });
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const session = await registry.crear({
    motor: engine,
    origen: "sala",
    proyecto: "repo",
    encargo: "Corrige el error en login",
    directorio: cwd,
    harness: true,
  });
  await registry.actualizar(session.id, { estado: state ?? "terminada" });
  const tracking = createTracking({
    registro: registry,
    checkpoints,
    cwdDe: (s) => s.directorio,
  });
  const fakeEngine = path.join(dir, "motor-falso.mjs");
  await writeFile(
    fakeEngine,
    `console.log(JSON.stringify({type:"result",result:JSON.stringify({titulo:"feat(login): redacta el PR",descripcion:"## Resumen\\nRedactado"})}));`,
  );
  const actions = createActions({
    registro: registry,
    seguimiento: tracking,
    checkpoints,
    pr: createPrClient({
      git: gitExecutor,
      info: checkpoints.info,
      // Internal runs leave a mark under HOME: never the developer's own.
      env: { ...process.env, HOME: dir },
      comando: () => ({ bin: process.execPath, args: [fakeEngine] }),
    }),
    catalogo: { modelos: async () => ({}) },
    proyectos: { repo: cwd },
  });
  const server = createLauncherServer({
    registro: registry,
    ejecutor: { entrada: () => ({ ok: true }) },
    acciones: actions,
    proyectos: { repo: cwd },
    controlHash: fingerprint("control"),
    hookHash: fingerprint("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, cuerpo) => {
    const r = await fetch(base + path, {
      method: cuerpo === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer control",
        "content-type": "application/json",
      },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
    });
    return { status: r.status, datos: await r.json().catch(() => null) };
  };
  return {
    cwd,
    dir,
    gh,
    registro: registry,
    sesion: session,
    seguimiento: tracking,
    pedir: request,
    bare: path.join(dir, "remoto.git"),
  };
}

test("las capacidades salen del código real de cada motor y se estrechan por repositorio", () => {
  assert.equal(CAPABILITIES.codex.reanudar, false);
  assert.equal(CAPABILITIES.agy.herramientasEstructuradas, "parcial");
  assert.equal(CAPABILITIES.deepseek.reportaUso, false);
  assert.ok(
    Object.values(CAPABILITIES).every((c) => c.revertirConversacion === false),
  );
  assert.equal(CAPABILITIES.codex.teclaInterrumpir, "Ctrl+C");
  const withoutRepo = capabilitiesOf({ motor: "claude", harness: true }, {});
  assert.deepEqual(
    [
      withoutRepo.esRepo,
      withoutRepo.revertirArchivos,
      withoutRepo.crearPr,
      withoutRepo.continuar,
    ],
    [false, false, false, true],
  );
  const withRepo = capabilitiesOf(
    { motor: "codex", harness: false },
    { esRepo: true, tieneRemoto: true, remotoGithub: true },
  );
  assert.deepEqual(
    [
      withRepo.revertirArchivos,
      withRepo.crearPr,
      withRepo.continuar,
      withRepo.interrumpir,
    ],
    [true, true, false, false],
  );
  assert.equal(capabilitiesOf({ motor: "otro" }), null);
  assert.equal(
    economyModel("claude", [{ id: "opus" }, { id: "haiku" }]),
    "haiku",
  );
  assert.equal(economyModel("codex", [{ id: "gpt-5" }]), null);
});

test("la propuesta es determinista: título convencional, archivos y cambios por turno", () => {
  assert.equal(
    slug("¡Corrige el ERROR en Login!!"),
    "corrige-el-error-en-login",
  );
  assert.equal(slug("***"), "cambios");
  const session = {
    id: "abcdef12-0000-4000-8000-000000000000",
    motor: "menta",
    encargo: "Corrige el error en login\nmás detalles",
    checkpoints: [
      {
        n: 1,
        mensaje: "Corrige el error en login",
        ts: "2026-01-02T03:04:05Z",
      },
      {
        n: 2,
        tipo: "reversion",
        mensaje: "Antes de revertir",
        ts: "2026-01-02T03:05:00Z",
      },
    ],
  };
  assert.equal(
    branchName({ ...session, motor: "codex" }),
    "sb/menta-corrige-el-error-en-login-abcdef",
  );
  const p = proposalPr({
    sesion: { ...session, motor: "codex" },
    archivos: [
      {
        ruta: "a.txt",
        estado: "M",
        añadidas: 2,
        eliminadas: 1,
        binario: false,
      },
    ],
    ultimaRespuesta: "Listo, arreglado.",
  });
  assert.equal(p.titulo, "fix: corrige el error en login");
  assert.match(p.descripcion, /## Resumen\n\nListo, arreglado\./);
  assert.match(p.descripcion, /`M` a\.txt \(\+2 −1\)/);
  assert.match(
    p.descripcion,
    /1\. Corrige el error en login \(2026-01-02 03:04\)/,
  );
  assert.doesNotMatch(p.descripcion, /Antes de revertir/);
});

test("hilo a rama a PR: crea la rama, el commit, empuja al remoto y abre el PR sin tokens en argumentos", async (t) => {
  const e = await environment(t);
  await e.seguimiento.marcar(e.sesion.id, "Corrige el error en login");
  await writeFile(path.join(e.cwd, "a.txt"), "arreglado\n");
  await writeFile(path.join(e.cwd, "nuevo.txt"), "nuevo\n");
  await writeFile(path.join(e.cwd, "ignorado.log"), "no va\n");

  const prop = await e.pedir(`/sesiones/${e.sesion.id}/pr/propuesta`);
  assert.equal(prop.status, 200);
  assert.equal(prop.datos.titulo, "fix: corrige el error en login");
  assert.match(prop.datos.descripcion, /a\.txt/);

  const r = await e.pedir(`/sesiones/${e.sesion.id}/pr`, {
    titulo: "fix: corrige el login",
    descripcion: "Cuerpo",
    borrador: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.match(
    r.datos.rama,
    /^sb\/ambar-corrige-el-error-en-login-[a-f0-9]{6}$/,
  );
  assert.equal(r.datos.url, "https://github.com/test/repo/pull/7");
  assert.equal(r.datos.commit, git(e.cwd, "rev-parse", "HEAD"));
  assert.equal(git(e.cwd, "branch", "--show-current"), r.datos.rama);
  assert.equal(git(e.cwd, "log", "-1", "--format=%s"), "fix: corrige el login");
  assert.equal(git(e.bare, "rev-parse", r.datos.rama), r.datos.commit);
  const files = git(e.cwd, "show", "--name-only", "--format=", "HEAD");
  assert.match(files, /a\.txt/);
  assert.match(files, /nuevo\.txt/);
  assert.doesNotMatch(files, /ignorado/);

  const crear = (await e.gh.llamadas()).find((a) => a[1] === "create");
  assert.ok(crear.includes("--draft"));
  assert.equal(crear[crear.indexOf("--title") + 1], "fix: corrige el login");
  assert.equal(crear[crear.indexOf("--base") + 1], "main");
  assert.ok(!JSON.stringify(crear).match(/token|ghp_/i));

  // Pressing the button again is idempotent: the open PR is returned.
  await writeFile(path.join(e.dir, "pr-existente"), "1");
  const otra = await e.pedir(`/sesiones/${e.sesion.id}/pr`, {});
  assert.equal(otra.status, 200);
  assert.equal(otra.datos.existente, true);
  assert.equal(otra.datos.rama, r.datos.rama);
});

test("sin cambios en la rama por defecto el PR se bloquea", async (t) => {
  const e = await environment(t);
  const r = await e.pedir(`/sesiones/${e.sesion.id}/pr`, {});
  assert.equal(r.status, 409);
  assert.match(r.datos.error, /No hay cambios/);
  assert.equal(git(e.cwd, "branch", "--show-current"), "main");
});

test("reutiliza la rama actual y devuelve el PR abierto en vez de crear otro", async (t) => {
  const e = await environment(t);
  git(e.cwd, "checkout", "-q", "-b", "mi-rama");
  await writeFile(path.join(e.cwd, "a.txt"), "cambio\n");
  await writeFile(path.join(e.dir, "pr-existente"), "1");
  const r = await e.pedir(`/sesiones/${e.sesion.id}/pr`, {});
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.rama, "mi-rama");
  assert.equal(r.datos.url, "https://github.com/test/repo/pull/3");
  assert.equal(r.datos.existente, true);
  assert.ok(!(await e.gh.llamadas()).some((a) => a[1] === "create"));
  assert.match(
    git(e.cwd, "log", "-1", "--format=%s"),
    /^fix: corrige el error/,
  );
});

test("revertir, pr y diff validan estado y capacidades antes de actuar", async (t) => {
  const trabajando = await environment(t, { estado: "trabajando" });
  let r = await trabajando.pedir(`/sesiones/${trabajando.sesion.id}/revertir`, {
    n: 1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, "Detén el turno antes de revertir");
  r = await trabajando.pedir(`/sesiones/${trabajando.sesion.id}/pr`, {});
  assert.equal(r.status, 409);

  const withoutRemote = await environment(t, { remoto: false });
  r = await withoutRemote.pedir(`/sesiones/${withoutRemote.sesion.id}/pr`, {});
  assert.equal(r.status, 409);
  assert.match(r.datos.error, /GitHub/);
  r = await withoutRemote.pedir(
    `/sesiones/${withoutRemote.sesion.id}/revertir`,
    {
      n: 9,
    },
  );
  assert.equal(r.status, 404);
  r = await withoutRemote.pedir(
    `/sesiones/${withoutRemote.sesion.id}/diff?desde=abc`,
  );
  assert.equal(r.status, 400);

  // Outside a repository there is nothing to revert.
  const folder = await mkdtemp(path.join(tmpdir(), "sb-plano-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(folder, { recursive: true });
  await withoutRemote.registro.actualizar(withoutRemote.sesion.id, {});
  const plain = await withoutRemote.registro.crear({
    motor: "claude",
    origen: "sala",
    proyecto: "x",
    directorio: folder,
  });
  await withoutRemote.registro.actualizar(plain.id, { estado: "terminada" });
  r = await withoutRemote.pedir(`/sesiones/${plain.id}/revertir`, { n: 1 });
  assert.equal(r.status, 409);
  assert.match(r.datos.error, /repositorio git/);
  const state = await withoutRemote.pedir("/estado");
  const suya = state.datos.find((s) => s.id === plain.id);
  assert.equal(suya.capacidades.esRepo, false);
  assert.equal(
    state.datos.find((s) => s.id === withoutRemote.sesion.id).capacidades
      .esRepo,
    true,
  );
  const caps = await withoutRemote.pedir("/capacidades");
  assert.equal(caps.datos.motores.claude.revertirConversacion, false);
});

test("revertir por HTTP restaura el árbol y el diff por turno lo refleja", async (t) => {
  const e = await environment(t);
  await e.seguimiento.marcar(e.sesion.id, "turno 1");
  await writeFile(path.join(e.cwd, "a.txt"), "turno 1\n");
  await e.seguimiento.marcar(e.sesion.id, "turno 2");
  await writeFile(path.join(e.cwd, "a.txt"), "turno 2\n");
  const turno2 = await e.pedir(
    `/sesiones/${e.sesion.id}/diff?desde=2&hasta=actual`,
  );
  assert.equal(turno2.status, 200);
  assert.deepEqual(
    turno2.datos.archivos.map((a) => [a.ruta, a.estado]),
    [["a.txt", "M"]],
  );
  const turno1 = await e.pedir(`/sesiones/${e.sesion.id}/diff?desde=1&hasta=2`);
  assert.match(turno1.datos.parche, /\+turno 1/);
  const r = await e.pedir(`/sesiones/${e.sesion.id}/revertir`, { n: 2 });
  assert.equal(r.status, 200);
  assert.equal(await readFile(path.join(e.cwd, "a.txt"), "utf8"), "turno 1\n");
});

test("redactar usa la ejecución corta del motor y falla sin romper la propuesta", async (t) => {
  const e = await environment(t);
  await e.seguimiento.marcar(e.sesion.id, "x");
  await writeFile(path.join(e.cwd, "a.txt"), "cambio\n");
  const r = await e.pedir(`/sesiones/${e.sesion.id}/pr/redactar`, {});
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.titulo, "feat(login): redacta el PR");
  assert.equal(r.datos.fuente, "agente");
  const withoutRepo = await environment(t, { remoto: false });
  const f = await withoutRepo.pedir(
    `/sesiones/${withoutRepo.sesion.id}/pr/redactar`,
    {},
  );
  assert.equal(f.status, 409);
});

test(
  "gh se encuentra en el PATH del lanzador",
  {
    skip:
      process.platform === "win32" &&
      "gh falso ejecutable por shebang; en Windows se inyecta con ghComando",
  },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-ghpath-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      path.join(dir, "gh"),
      `#!${process.execPath}\nconsole.log("https://github.com/test/repo/pull/1");\n`,
    );
    await chmod(path.join(dir, "gh"), 0o755);
    const g = createGit({
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
    });
    assert.match((await g.gh(dir, ["pr", "create"])).stdout, /pull\/1/);
  },
);

test("redactar no usa el id de la sesión y marca su conversación como interna", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-redactar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const traza = path.join(dir, "traza.json");
  const fake = path.join(dir, "motor.mjs");
  const native = "c3333333-3333-4333-8333-333333333333";
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(traza)}, JSON.stringify({ args: process.argv.slice(2), sesion: process.env.SB_SESSION_ID }));
console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(native)} }));
console.log(JSON.stringify({ type: "result", result: JSON.stringify({ titulo: "feat: x", descripcion: "y" }) }));`,
  );
  const sesion = {
    id: "d4444444-4444-4444-8444-444444444444",
    motor: "claude",
    encargo: "Prueba",
  };
  const pr = createPrClient({
    git: createGit(),
    info: async () => ({}),
    env: { PATH: process.env.PATH, HOME: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
  });
  const r = await pr.redactar({
    sesion,
    cwd: dir,
    propuesta: { titulo: "feat: a", descripcion: "b" },
  });
  assert.equal(r.titulo, "feat: x");
  const { args, sesion: usada } = JSON.parse(await readFile(traza, "utf8"));
  assert.notEqual(usada, sesion.id);
  assert.equal(args.at(-2), "--session-id");
  assert.equal(args.at(-1), usada);
  const internal = path.join(dir, "estado/lanzador/internas");
  for (const id of [usada, native])
    assert.ok((await stat(path.join(internal, id + ".json"))).isFile(), id);
});
