import test from "node:test";
import assert from "node:assert/strict";
import { comandoHarness } from "../harness.mjs";
import { prepararAgy, prepararClaude } from "../claude-config.mjs";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { abrirRegistro } from "../sesiones.mjs";
import { crearEjecutor } from "../ejecucion.mjs";
import { abrirEspacios } from "../espacios.mjs";

test("uses each original interactive CLI", () => {
  for (const motor of ["claude", "codex", "agy", "deepseek"]) {
    const spec = comandoHarness({ motor, id: "test", modelo: null }, "hola");
    assert.equal(spec.bin, motor === "deepseek" ? "claude" : motor);
    assert.ok(!spec.args.includes("exec"));
    assert.ok(!spec.args.includes("-p"));
  }
});

test(
  "native PTY accepts keys, replays output and persists history without a model",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-pty-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = path.join(dir, "fake.mjs");
    await writeFile(
      fake,
      `console.log('READY');process.stdin.on('data', d=>{console.log('ECHO:'+d.toString());if(d.toString().includes('exit'))process.exit(0)});`,
    );
    const registro = await abrirRegistro(path.join(dir, "sessions.json"));
    const espacios = await abrirEspacios({
      archivo: path.join(dir, "spaces.json"),
      proyectos: {},
      workspaces: path.join(dir, "workspaces"),
    });
    const runner = crearEjecutor({
      registro,
      espacios,
      proyectos: {},
      comandoInteractivo: () => ({ bin: process.execPath, args: [fake] }),
    });
    const s = await runner.encargar({
      motor: "claude",
      origen: "sala",
      espacioId: "p1",
      proyecto: "p1",
      harness: true,
      brief: "hola",
    });
    t.after(async () => {
      if (runner.activos()) {
        await runner.cancelar(s.id);
        await runner.esperar(s.id);
      }
    });
    for (
      let i = 0;
      i < 100 && !(await runner.terminal(s.id)).datos.includes("READY");
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.match((await runner.terminal(s.id)).datos, /READY/);
    runner.entrada(s.id, { cols: 80, rows: 24 });
    runner.entrada(s.id, { raw: "hello\rexit\r" });
    await runner.esperar(s.id);
    assert.match((await runner.terminal(s.id)).datos, /ECHO:hello/);
    assert.equal((await runner.terminal(s.id)).activa, false);
    const saved = registro.leer()[0];
    assert.equal(saved.espacioId, "p1");
    assert.equal(saved.proyecto, null);
    assert.ok(saved.directorio.startsWith(path.join(dir, "workspaces")));
    const reopened = await abrirRegistro(path.join(dir, "sessions.json"));
    const restored = crearEjecutor({ registro: reopened, proyectos: {} });
    const output = await restored.terminal(s.id);
    assert.match(output.datos, /ECHO:hello/);
    assert.equal(output.activa, false);
  },
);

test("Marina abre su propio harness: identidad DeepSeek y effort solo para Claude", () => {
  const marina = comandoHarness(
    {
      motor: "deepseek",
      id: "m",
      modelo: "deepseek-flash[1m]",
      esfuerzo: "high",
    },
    "hola",
  ).args;
  assert.ok(marina.includes("--append-system-prompt"));
  assert.ok(!marina.includes("--model") && !marina.includes("--effort"));
  const ambar = comandoHarness(
    { motor: "claude", id: "a", modelo: "opus", esfuerzo: "xhigh" },
    "hola",
  ).args;
  assert.deepEqual(ambar.slice(-6), [
    "--model",
    "opus",
    "--effort",
    "xhigh",
    "--",
    "hola",
  ]);
  assert.ok(!ambar.includes("--append-system-prompt"));
});

test("el harness de Claude usa el MCP local aunque el repositorio traiga su .mcp.json", () => {
  const entorno = {
    SB_BRAIN_TOKEN_FILE: "/agente/brain-token",
    SB_BRAIN_URL: "http://127.0.0.1:8080/api/v1",
    SB_AGENTE: "ambar",
    SB_SESSION_ID: "s1",
    CLAUDE_CODE_OAUTH_TOKEN: "no-debe-viajar",
  };
  const { args } = comandoHarness(
    { motor: "claude", id: "s1" },
    "hola",
    entorno,
  );
  const i = args.indexOf("--mcp-config");
  // --mcp-config is variadic: only another flag ends its list.
  assert.equal(args[i + 2], "--strict-mcp-config");
  const {
    command,
    args: mcp,
    env,
  } = JSON.parse(args[i + 1]).mcpServers.secondbrain;
  assert.equal(command, process.execPath);
  assert.match(mcp[0], /mcp[\\/]index\.mjs$/);
  assert.equal(env.SB_AGENTE, "ambar");
  assert.equal(env.SB_BRAIN_TOKEN_FILE, "/agente/brain-token");
  assert.ok(!args[i + 1].includes("no-debe-viajar"));
  assert.ok(
    !comandoHarness({ motor: "claude", id: "x" }, "hola").args.includes(
      "--mcp-config",
    ),
  );
});

test(
  "Lira recibe su primer mensaje y sobrevive a la pista de la terminal",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-agy-pty-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = path.join(dir, "fake-agy.mjs");
    // Styled like a real TUI: the hint arrives split by colour codes.
    await writeFile(
      fake,
      `process.stdout.write('\\x1b[2m? for\\x1b[0m shortcuts\\n');process.stdin.on('data', d=>{console.log('ECHO:'+d.toString());if(d.toString().includes('salir'))process.exit(0)});`,
    );
    const registro = await abrirRegistro(path.join(dir, "sessions.json"));
    const espacios = await abrirEspacios({
      archivo: path.join(dir, "spaces.json"),
      proyectos: {},
      workspaces: path.join(dir, "workspaces"),
    });
    const runner = crearEjecutor({
      registro,
      espacios,
      proyectos: {},
      env: { PATH: process.env.PATH, HOME: dir },
      comandoInteractivo: () => ({ bin: process.execPath, args: [fake] }),
    });
    const s = await runner.encargar({
      motor: "agy",
      origen: "sala",
      espacioId: "p1",
      proyecto: "p1",
      harness: true,
      brief: "primer encargo",
    });
    t.after(async () => {
      if (runner.activos()) {
        await runner.cancelar(s.id);
        await runner.esperar(s.id);
      }
    });
    for (
      let i = 0;
      i < 200 &&
      !(await runner.terminal(s.id)).datos.includes("primer encargo");
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.match((await runner.terminal(s.id)).datos, /primer encargo/);
    assert.equal((await runner.terminal(s.id)).activa, true);
    runner.entrada(s.id, { cols: 80, rows: 24 });
    runner.entrada(s.id, { raw: "salir\r" });
    await runner.esperar(s.id);
    assert.equal(registro.leer()[0].estado, "terminada");
    assert.throws(() => runner.entrada(s.id, { cols: 80, rows: 24 }), {
      message: "Terminal no disponible",
    });
  },
);

test("prepara la configuración de cada agente sin perder datos ni tocar otra", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-claude-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({ userID: "x", projects: { "/otro": { a: 1 } } }),
  );
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [] } }),
  );
  await prepararClaude(dir, "/w/p1", { firma: "Marina · DeepSeek" });
  const config = JSON.parse(
    await readFile(path.join(dir, ".claude.json"), "utf8"),
  );
  assert.equal(config.userID, "x");
  assert.equal(config.hasCompletedOnboarding, true);
  assert.deepEqual(config.projects["/otro"], { a: 1 });
  assert.equal(config.projects["/w/p1"].hasTrustDialogAccepted, true);
  const settings = JSON.parse(
    await readFile(path.join(dir, "settings.json"), "utf8"),
  );
  assert.deepEqual(settings.hooks, { Stop: [] });
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.match(settings.statusLine.command, /Marina · DeepSeek/);
  await writeFile(path.join(dir, ".claude.json"), "{roto");
  await prepararClaude(dir, "/w/p2");
  assert.equal(await readFile(path.join(dir, ".claude.json"), "utf8"), "{roto");
});

test("Lira confía en el espacio del proyecto antes de abrir Antigravity", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-agy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const archivo = path.join(home, ".gemini/antigravity-cli/settings.json");
  await mkdir(path.dirname(archivo), { recursive: true });
  await writeFile(
    archivo,
    JSON.stringify({ theme: "x", trustedWorkspaces: ["/srv/repo"] }),
  );
  await prepararAgy(home, "/datos/workspaces/p1");
  await prepararAgy(home, "/datos/workspaces/p1");
  const datos = JSON.parse(await readFile(archivo, "utf8"));
  assert.equal(datos.theme, "x");
  assert.deepEqual(datos.trustedWorkspaces, [
    "/srv/repo",
    "/datos/workspaces/p1",
  ]);
});
