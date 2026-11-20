import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLauncherServer } from "../index.mjs";
import { openSessionRegistry } from "../sessions.mjs";
import { createExecutor } from "../executor.mjs";
import { runCli, analyze } from "../cli.mjs";

const fingerprint = (token) => createHash("sha256").update(token).digest("hex");
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** An in-memory launcher: real registry and executor, a fake CLI as the engine. */
async function testLauncher(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const falso = path.join(dir, "falso.mjs");
  await writeFile(
    falso,
    `const brief = process.argv[2];
if (brief.includes("DORMIR")) setInterval(() => {}, 1000);
else if (brief.includes("FALLAR")) { console.log(JSON.stringify({ type: "result", is_error: true, result: "mal" })); process.exit(1); }
else setTimeout(() => { console.log(JSON.stringify({ type: "result", session_id: "conv-1", result: "Respuesta para: " + brief })); }, 150);`,
  );
  const registro = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const ejecutor = createExecutor({
    registro,
    proyectos: { demo: dir },
    comando: (_engine, brief) => ({
      bin: process.execPath,
      args: [falso, brief],
    }),
  });
  const server = createLauncherServer({
    registro,
    ejecutor,
    proyectos: { demo: dir },
    controlHash: fingerprint("control-secreto"),
    hookHash: fingerprint("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const fileToken = path.join(dir, "token");
  await writeFile(fileToken, "control-secreto\n");
  const env = {
    LANZADOR_URL: `http://127.0.0.1:${server.address().port}`,
    LANZADOR_TOKEN_FILE: fileToken,
  };
  const run = async (...argv) => {
    let output = "";
    let error = "";
    const code = await runCli(argv, {
      env,
      salida: (x) => (output += x),
      error: (x) => (error += x),
      sondeo: 50,
    });
    return { codigo: code, salida: output, error };
  };
  return { correr: run, registro, ejecutor, env, dir };
}

test("analiza opciones con valor, booleanas, = y -- sin tragarse el brief", () => {
  const r = analyze([
    "--agente=lira",
    "--wait",
    "iniciar",
    "--",
    "--no-es-opcion",
    "texto",
  ]);
  assert.deepEqual(r.opciones, { agente: "lira", wait: true });
  assert.deepEqual(r.posicionales, ["iniciar", "--no-es-opcion", "texto"]);
  assert.throws(() => analyze(["--inventada"]), /desconocida/);
  assert.throws(() => analyze(["--agente"]), /Falta el valor/);
});

test("iniciar --wait --json espera al turno, devuelve una línea JSON y sale con 0", async (t) => {
  const { correr: run } = await testLauncher(t);
  const r = await run(
    "iniciar",
    "--agente",
    "ambar",
    "--proyecto",
    "demo",
    "--wait",
    "--json",
    "Haz algo",
  );
  assert.equal(r.codigo, 0, r.error + r.salida);
  assert.equal(r.salida.trim().split("\n").length, 1);
  const data = JSON.parse(r.salida);
  assert.equal(data.estado, "terminada");
  assert.equal(data.agente, "ambar");
  assert.equal(data.respuesta, "Respuesta para: Haz algo");
  assert.ok(!r.salida.includes("control-secreto"));
});

test("sin --json imprime texto en español con la última respuesta; ver, listar y enviar", async (t) => {
  const { correr: run } = await testLauncher(t);
  const ini = await run(
    "iniciar",
    "--agente",
    "ambar",
    "--proyecto",
    "demo",
    "--wait",
    "Primero",
  );
  assert.equal(ini.codigo, 0);
  assert.match(ini.salida, /: terminada/);
  assert.match(ini.salida, /Respuesta para: Primero/);
  const id = /Hilo ([a-f0-9-]{36})/.exec(ini.salida)[1];

  const ver = await run("ver", id);
  assert.equal(ver.codigo, 0);
  assert.match(ver.salida, /Respuesta para: Primero/);

  const listado = await run(
    "listar",
    "--proyecto",
    "demo",
    "--estado",
    "terminada",
  );
  assert.match(listado.salida, new RegExp(id));
  assert.equal(
    (await run("listar", "--proyecto", "otro")).salida,
    "No hay hilos.\n",
  );
  assert.equal(JSON.parse((await run("listar", "--json")).salida)[0].id, id);

  const sig = await run("enviar", id, "Segundo", "mensaje", "--wait");
  assert.equal(sig.codigo, 0, sig.error + sig.salida);
  assert.match(sig.salida, /Respuesta para: Segundo mensaje/);
});

test("códigos de salida: 1 si el turno falla, 124 al vencer --timeout, 2 por uso incorrecto", async (t) => {
  const {
    correr: run,
    ejecutor: executor,
    registro: registry,
  } = await testLauncher(t);
  const mala = await run(
    "iniciar",
    "--agente",
    "menta",
    "--proyecto",
    "demo",
    "--wait",
    "--json",
    "FALLAR",
  );
  assert.equal(mala.codigo, 1);
  assert.equal(JSON.parse(mala.salida).estado, "error");

  const lenta = await run(
    "iniciar",
    "--agente",
    "ambar",
    "--proyecto",
    "demo",
    "--wait",
    "--timeout",
    "1",
    "--json",
    "DORMIR",
  );
  assert.equal(lenta.codigo, 124);
  const data = JSON.parse(lenta.salida);
  assert.equal(data.vencio, true);
  const det = await run("detener", data.id);
  assert.equal(det.codigo, 0);
  await executor.esperar(data.id);
  assert.equal(
    registry.leer().find((s) => s.id === data.id).estado,
    "cancelada",
  );

  assert.equal((await run("iniciar", "--proyecto", "demo", "x")).codigo, 2);
  assert.equal(
    (await run("iniciar", "--agente", "ambar", "--proyecto", "demo")).codigo,
    2,
  );
  assert.equal((await run("ver", "no-es-id")).codigo, 2);
  assert.equal((await run("inventado")).codigo, 2);
  const missing = await run("ver", "00000000-0000-4000-8000-000000000000");
  assert.equal(missing.codigo, 1);
  assert.match(missing.error, /inexistente/);
});

test("el origen cron se acepta, un proyecto desconocido falla sin filtrar el token y --help funciona", async (t) => {
  const { correr: run, registro: registry } = await testLauncher(t);
  const cron = await run(
    "iniciar",
    "--agente",
    "lira",
    "--proyecto",
    "demo",
    "--origen",
    "cron",
    "--wait",
    "--json",
    "Tarea",
  );
  assert.equal(cron.codigo, 0);
  assert.equal(registry.leer().at(-1).origen, "cron");
  assert.equal(registry.leer().at(-1).motor, "agy");
  const raro = await run(
    "iniciar",
    "--agente",
    "ambar",
    "--proyecto",
    "inexistente",
    "Tarea",
  );
  assert.equal(raro.codigo, 1);
  assert.ok(!raro.error.includes("control-secreto"));
  const ayuda = await run("--help");
  assert.equal(ayuda.codigo, 0);
  assert.match(ayuda.salida, /sb-hilo/);
});

test("rechaza un lanzador fuera de loopback y falla con claridad si no hay token", async () => {
  let error = "";
  const cod = await runCli(["listar"], {
    env: { LANZADOR_URL: "http://10.0.0.5:8092", LANZADOR_TOKEN_FILE: "/x" },
    error: (x) => (error += x),
  });
  assert.equal(cod, 1);
  assert.match(error, /loopback/);
  error = "";
  const sin = await runCli(["listar"], {
    env: {},
    error: (x) => (error += x),
  });
  assert.equal(sin, 1);
  assert.match(error, /LANZADOR_TOKEN_FILE/);
});

test("el binario se ejecuta de verdad: --help sale con 0 y sin argumentos con 2", async () => {
  const run = (args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [CLI, ...args],
        { env: { PATH: process.env.PATH } },
        (e) => resolve({ codigo: e ? e.code : 0 }),
      ),
    );
  assert.equal((await run(["--help"])).codigo, 0);
  assert.equal((await run([])).codigo, 2);
});

test("arranca también desde una ruta enlazada, como /opt/secondbrain/current", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-cli-enlace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { symlink } = await import("node:fs/promises");
  const enlace = path.join(dir, "current");
  // A junction needs no privileges on Windows; elsewhere it is a plain symlink.
  await symlink(
    fileURLToPath(new URL("..", import.meta.url)),
    enlace,
    process.platform === "win32" ? "junction" : "dir",
  );
  const output = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [path.join(enlace, "cli.mjs"), "--help"],
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.match(output, /iniciar/);
});
