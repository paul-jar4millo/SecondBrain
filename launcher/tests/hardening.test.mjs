import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openSessionRegistry } from "../sessions.mjs";
import { createExecutor } from "../executor.mjs";
import { createLauncherServer } from "../index.mjs";
import { createHash } from "node:crypto";
import { watchConversations } from "../conversations.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-audit-p2-"));
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return dir;
}

test("continuar absorbe rechazos del checkpoint en harness y headless", async (t) => {
  const dir = await fixture(t);
  for (const harness of [false, true]) {
    const registro = await openSessionRegistry(
      path.join(dir, `sessions-${harness}.json`),
    );
    const s = await registro.crear({
      motor: "claude",
      origen: "sala",
      proyecto: "p",
      directorio: dir,
      harness,
    });
    await registro.actualizar(s.id, {
      estado: "terminada",
      conversacionId: "native",
    });
    const runner = createExecutor({
      registro,
      proyectos: { p: dir },
      seguimiento: {
        marcar: async () => {
          throw new Error("checkpoint roto");
        },
      },
    });
    await runner.continuar(s.id, "seguir");
    await assert.doesNotReject(runner.esperar(s.id));
    assert.equal(registro.leer()[0].estado, "error");
    assert.equal(runner.activos(), 0);
  }
});

test("HTTP conserva un acento dividido entre dos buffers", async (t) => {
  let recibido;
  const hash = createHash("sha256").update("control").digest("hex");
  const server = createLauncherServer({
    registro: { leer: () => [], subscribe: () => () => {} },
    ejecutor: {
      encargar: async (datos) => {
        recibido = datos.brief;
        return { id: "ok" };
      },
    },
    controlHash: hash,
    hookHash: createHash("sha256").update("hook").digest("hex"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const body = Buffer.from(
    JSON.stringify({ motor: "claude", brief: "México" }),
  );
  const split = body.indexOf(Buffer.from("é")) + 1;
  const req = request({
    hostname: "127.0.0.1",
    port: server.address().port,
    path: "/sesiones",
    method: "POST",
    headers: {
      authorization: "Bearer control",
      "content-type": "application/json",
    },
  });
  const response = once(req, "response");
  req.write(body.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  req.end(body.subarray(split));
  const [res] = await response;
  res.resume();
  await once(res, "end");
  assert.equal(res.statusCode, 202);
  assert.equal(recibido, "México");
});

test("el replay PTY conserva UTF-8 dividido", async (t) => {
  const dir = await fixture(t);
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill() {},
  });
  const runner = createExecutor({
    registro,
    proyectos: { p: dir },
    comandoInteractivo: () => ({ bin: "fake", args: [] }),
    lanzarPty: () => child,
  });
  const s = await runner.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "p",
    harness: true,
    brief: "x",
  });
  for (let i = 0; i < 100 && !registro.leer()[0]?.interactiva; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    registro.leer()[0].interactiva,
    true,
    JSON.stringify(registro.leer()[0]),
  );
  const bytes = Buffer.from("México 🧠");
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
  await runner.esperar(s.id);
  assert.match((await runner.terminal(s.id)).datos, /México 🧠/);
});

test("errores inesperados son 500 y el diagnóstico oculta encargo y token", async (t) => {
  const lines = [];
  const server = createLauncherServer({
    registro: { leer: () => [], subscribe: () => () => {} },
    ejecutor: {
      encargar: async (datos) => {
        throw new Error(`EIO: ${datos.brief}; Bearer credencial-sintetica`);
      },
    },
    controlHash: createHash("sha256").update("control").digest("hex"),
    hookHash: createHash("sha256").update("hook").digest("hex"),
    registrar: (line) => lines.push(line),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/sesiones`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer control",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        motor: "claude",
        brief: "encargo privado sintético",
      }),
    },
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes("EIO"), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /EIO/);
  assert.doesNotMatch(
    lines[0],
    /encargo privado sintético|credencial-sintetica/,
  );
});

test("migra mensajes y terminal a detalle por sesión y los recupera", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "sessions.json");
  const old = {
    id: "legacy",
    motor: "claude",
    origen: "sala",
    estado: "terminada",
    creada: new Date().toISOString(),
    terminal: "pantalla México",
    mensajes: [{ rol: "user", texto: "mensaje antiguo" }],
  };
  await writeFile(file, JSON.stringify([old]));
  const registro = await openSessionRegistry(file);
  assert.deepEqual(registro.leer()[0].mensajes, old.mensajes);
  const metadata = JSON.parse(await readFile(file, "utf8"));
  assert.equal(metadata[0].terminal, undefined);
  assert.equal(metadata[0].mensajes, undefined);
  await registro.actualizar("legacy", { ultimaAccion: "Listo" });
  const reopened = await openSessionRegistry(file);
  assert.equal(reopened.leer()[0].terminal, "pantalla México");
  assert.deepEqual(reopened.leer()[0].mensajes, old.mensajes);
  const snapshot = reopened.leer();
  assert.equal(reopened.leer(), snapshot);
  assert.throws(() =>
    snapshot[0].mensajes.push({ rol: "user", texto: "alteración" }),
  );
});

test("retiene activas y recientes, poda terminadas y lápidas antiguas", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "sessions.json");
  const antigua = "2020-01-01T00:00:00.000Z";
  const reciente = new Date().toISOString();
  await writeFile(
    file,
    JSON.stringify([
      {
        id: "old",
        estado: "terminada",
        creada: antigua,
        finalizada: antigua,
        terminal: "viejo",
      },
      {
        id: "tombstone",
        estado: "terminada",
        creada: antigua,
        eliminada: true,
        eliminadaEn: antigua,
      },
      { id: "active", estado: "trabajando", creada: antigua },
      { id: "new", estado: "terminada", creada: reciente },
    ]),
  );
  const registro = await openSessionRegistry(file);
  assert.deepEqual(
    registro.leer().map((s) => s.id),
    ["active", "new"],
  );
  assert.equal(registro.leer()[0].estado, "interrumpida");
});

test("conserva sesiones legacy cuya fecha final no se conoce", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "sessions.json");
  await writeFile(
    file,
    JSON.stringify([
      { id: "legacy", estado: "terminada", creada: "2020-01-01T00:00:00.000Z" },
    ]),
  );
  const registro = await openSessionRegistry(file);
  assert.equal(registro.leer()[0]?.id, "legacy");
  assert.ok(Date.parse(registro.leer()[0].finalizada) > Date.now() - 60000);
});

test("un error al señalar el proceso no escapa del vigilante", async (t) => {
  const dir = await fixture(t);
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill() {
      const error = new Error("proceso ausente");
      error.code = "ESRCH";
      throw error;
    },
  });
  const timers = [];
  const runner = createExecutor({
    registro,
    proyectos: { p: dir },
    comandoInteractivo: () => ({ bin: "fake", args: [] }),
    lanzarPty: () => child,
    programar: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
    cancelarTemporizador() {},
    limiteMs: 500,
    registrar() {},
  });
  const s = await runner.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "p",
    harness: true,
    brief: "x",
  });
  for (let i = 0; i < 100 && !child.listenerCount("close"); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    assert.doesNotThrow(timers.find((timer) => timer.ms === 500).fn);
  } finally {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null);
    await runner.esperar(s.id);
  }
  assert.equal(runner.activos(), 0);
});

test("una sesión sin salida avisa y se cancela al agotar el tope", async (t) => {
  const dir = await fixture(t);
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setInterval(() => {}, 1000);");
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const notices = [];
  registro.subscribe((ss) => {
    if (ss[0]?.ultimaAccion) notices.push(ss[0].ultimaAccion);
  });
  const runner = createExecutor({
    registro,
    proyectos: { p: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    limiteMs: 200,
    inactividadMs: 30,
  });
  const s = await runner.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "p",
    brief: "x",
  });
  await runner.esperar(s.id);
  assert.equal(registro.leer()[0].estado, "error");
  assert.match(registro.leer()[0].error, /tiempo máximo/);
  assert.ok(notices.some((text) => /Sin actividad/.test(text)));
  assert.equal(runner.activos(), 0);
});

test("un fallo al confirmar el índice conserva el detalle anterior", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "sessions.json");
  const registro = await openSessionRegistry(file);
  const s = await registro.crear({ motor: "codex", origen: "sala" });
  await registro.actualizar(s.id, { estado: "terminada", terminal: "antes" });
  await mkdir(file + ".tmp");
  await assert.rejects(registro.actualizar(s.id, { terminal: "después" }));
  assert.equal(registro.leer()[0].terminal, "antes");
  const restored = await openSessionRegistry(file);
  assert.equal(restored.leer()[0].terminal, "antes");
  assert.equal((await readdir(file + ".d")).length, 1);
});

test("el observador no resucita transcripts vencidos al podar lápidas", async (t) => {
  const dir = await fixture(t);
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const folder = path.join(dir, "claude/projects/p");
  await mkdir(folder, { recursive: true });
  const transcript = (text) =>
    JSON.stringify({ type: "user", message: { content: text } });
  const oldId = "e5555555-5555-4555-8555-555555555555";
  const newId = "f6666666-6666-4666-8666-666666666666";
  const oldFile = path.join(folder, oldId + ".jsonl");
  await writeFile(oldFile, transcript("Antigua"));
  await utimes(oldFile, new Date("2020-01-01"), new Date("2020-01-01"));
  await writeFile(path.join(folder, newId + ".jsonl"), transcript("Actual"));
  const stop = watchConversations({
    registro,
    env: { HOME: dir },
    proyectos: {},
    intervalo: 10,
  });
  t.after(stop);
  for (
    let i = 0;
    i < 100 && !registro.leer().some((s) => s.conversacionId === newId);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    registro.leer().map((s) => s.conversacionId),
    [newId],
  );
  stop();
});

test("conserva stderr acotado sin secretos ni el encargo", async (t) => {
  const dir = await fixture(t);
  const fake = path.join(dir, "fake.mjs");
  const brief = "encargo sintético privado" + "A".repeat(2500);
  await writeFile(
    fake,
    `process.stderr.write('x'.repeat(10000) + ' EIO ${brief} token-sintetico');process.exit(1);`,
  );
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const logs = [];
  const runner = createExecutor({
    registro,
    proyectos: { p: dir },
    env: { ...process.env, DEEPSEEK_API_KEY: "token-sintetico" },
    comando: () => ({ bin: process.execPath, args: [fake] }),
    registrar: (line) => logs.push(line),
  });
  const s = await runner.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "p",
    brief,
  });
  await runner.esperar(s.id);
  assert.equal(registro.leer()[0].estado, "error");
  assert.equal(logs.length, 1);
  const log = JSON.parse(logs[0]);
  assert.match(log.diagnostico, /EIO/);
  assert.ok(log.diagnostico.length <= 2000);
  assert.doesNotMatch(logs[0], /encargo sintético privado|token-sintetico/);
  assert.doesNotMatch(logs[0], /A{20}/);
});

test("el tope también termina un harness inactivo", async (t) => {
  const dir = await fixture(t);
  const registro = await openSessionRegistry(path.join(dir, "sessions.json"));
  const child = new EventEmitter();
  const signals = [];
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill(signal) {
      signals.push(signal);
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null);
      });
    },
  });
  const runner = createExecutor({
    registro,
    proyectos: { p: dir },
    comandoInteractivo: () => ({ bin: "fake", args: [] }),
    lanzarPty: () => child,
    limiteMs: 50,
    inactividadMs: 10,
  });
  const s = await runner.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "p",
    harness: true,
    brief: "x",
  });
  await runner.esperar(s.id);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(registro.leer()[0].interactiva, false);
  assert.equal(registro.leer()[0].estado, "error");
  assert.match(registro.leer()[0].error, /tiempo máximo/);
  assert.equal(runner.activos(), 0);
});
