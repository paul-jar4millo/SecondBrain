import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crearServidor } from "../index.mjs";
import { abrirRegistro } from "../sessions.mjs";
import { crearEjecutor } from "../executor.mjs";
import { ejecutarCli, analizar } from "../cli.mjs";

const huella = (token) => createHash("sha256").update(token).digest("hex");
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** An in-memory launcher: real registry and executor, a fake CLI as the engine. */
async function lanzadorDePrueba(t) {
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
  const registro = await abrirRegistro(path.join(dir, "sesiones.json"));
  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: dir },
    comando: (_motor, brief) => ({
      bin: process.execPath,
      args: [falso, brief],
    }),
  });
  const servidor = crearServidor({
    registro,
    ejecutor,
    proyectos: { demo: dir },
    controlHash: huella("control-secreto"),
    hookHash: huella("hook"),
  });
  servidor.listen(0, "127.0.0.1");
  await once(servidor, "listening");
  t.after(() => servidor.close());
  const archivoToken = path.join(dir, "token");
  await writeFile(archivoToken, "control-secreto\n");
  const env = {
    LANZADOR_URL: `http://127.0.0.1:${servidor.address().port}`,
    LANZADOR_TOKEN_FILE: archivoToken,
  };
  const correr = async (...argv) => {
    let salida = "";
    let error = "";
    const codigo = await ejecutarCli(argv, {
      env,
      salida: (x) => (salida += x),
      error: (x) => (error += x),
      sondeo: 50,
    });
    return { codigo, salida, error };
  };
  return { correr, registro, ejecutor, env, dir };
}

test("analiza opciones con valor, booleanas, = y -- sin tragarse el brief", () => {
  const r = analizar([
    "--agente=lira",
    "--wait",
    "iniciar",
    "--",
    "--no-es-opcion",
    "texto",
  ]);
  assert.deepEqual(r.opciones, { agente: "lira", wait: true });
  assert.deepEqual(r.posicionales, ["iniciar", "--no-es-opcion", "texto"]);
  assert.throws(() => analizar(["--inventada"]), /desconocida/);
  assert.throws(() => analizar(["--agente"]), /Falta el valor/);
});

test("iniciar --wait --json espera al turno, devuelve una línea JSON y sale con 0", async (t) => {
  const { correr } = await lanzadorDePrueba(t);
  const r = await correr(
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
  const datos = JSON.parse(r.salida);
  assert.equal(datos.estado, "terminada");
  assert.equal(datos.agente, "ambar");
  assert.equal(datos.respuesta, "Respuesta para: Haz algo");
  assert.ok(!r.salida.includes("control-secreto"));
});

test("sin --json imprime texto en español con la última respuesta; ver, listar y enviar", async (t) => {
  const { correr } = await lanzadorDePrueba(t);
  const ini = await correr(
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

  const ver = await correr("ver", id);
  assert.equal(ver.codigo, 0);
  assert.match(ver.salida, /Respuesta para: Primero/);

  const listado = await correr(
    "listar",
    "--proyecto",
    "demo",
    "--estado",
    "terminada",
  );
  assert.match(listado.salida, new RegExp(id));
  assert.equal(
    (await correr("listar", "--proyecto", "otro")).salida,
    "No hay hilos.\n",
  );
  assert.equal(JSON.parse((await correr("listar", "--json")).salida)[0].id, id);

  const sig = await correr("enviar", id, "Segundo", "mensaje", "--wait");
  assert.equal(sig.codigo, 0, sig.error + sig.salida);
  assert.match(sig.salida, /Respuesta para: Segundo mensaje/);
});

test("códigos de salida: 1 si el turno falla, 124 al vencer --timeout, 2 por uso incorrecto", async (t) => {
  const { correr, ejecutor, registro } = await lanzadorDePrueba(t);
  const mala = await correr(
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

  const lenta = await correr(
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
  const datos = JSON.parse(lenta.salida);
  assert.equal(datos.vencio, true);
  const det = await correr("detener", datos.id);
  assert.equal(det.codigo, 0);
  await ejecutor.esperar(datos.id);
  assert.equal(
    registro.leer().find((s) => s.id === datos.id).estado,
    "cancelada",
  );

  assert.equal((await correr("iniciar", "--proyecto", "demo", "x")).codigo, 2);
  assert.equal(
    (await correr("iniciar", "--agente", "ambar", "--proyecto", "demo")).codigo,
    2,
  );
  assert.equal((await correr("ver", "no-es-id")).codigo, 2);
  assert.equal((await correr("inventado")).codigo, 2);
  const noExiste = await correr("ver", "00000000-0000-4000-8000-000000000000");
  assert.equal(noExiste.codigo, 1);
  assert.match(noExiste.error, /inexistente/);
});

test("el origen cron se acepta, un proyecto desconocido falla sin filtrar el token y --help funciona", async (t) => {
  const { correr, registro } = await lanzadorDePrueba(t);
  const cron = await correr(
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
  assert.equal(registro.leer().at(-1).origen, "cron");
  assert.equal(registro.leer().at(-1).motor, "agy");
  const raro = await correr(
    "iniciar",
    "--agente",
    "ambar",
    "--proyecto",
    "inexistente",
    "Tarea",
  );
  assert.equal(raro.codigo, 1);
  assert.ok(!raro.error.includes("control-secreto"));
  const ayuda = await correr("--help");
  assert.equal(ayuda.codigo, 0);
  assert.match(ayuda.salida, /sb-hilo/);
});

test("rechaza un lanzador fuera de loopback y falla con claridad si no hay token", async () => {
  let error = "";
  const cod = await ejecutarCli(["listar"], {
    env: { LANZADOR_URL: "http://10.0.0.5:8092", LANZADOR_TOKEN_FILE: "/x" },
    error: (x) => (error += x),
  });
  assert.equal(cod, 1);
  assert.match(error, /loopback/);
  error = "";
  const sin = await ejecutarCli(["listar"], {
    env: {},
    error: (x) => (error += x),
  });
  assert.equal(sin, 1);
  assert.match(error, /LANZADOR_TOKEN_FILE/);
});

test("el binario se ejecuta de verdad: --help sale con 0 y sin argumentos con 2", async () => {
  const correr = (args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [CLI, ...args],
        { env: { PATH: process.env.PATH } },
        (e) => resolve({ codigo: e ? e.code : 0 }),
      ),
    );
  assert.equal((await correr(["--help"])).codigo, 0);
  assert.equal((await correr([])).codigo, 2);
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
  const salida = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [path.join(enlace, "cli.mjs"), "--help"],
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.match(salida, /iniciar/);
});
