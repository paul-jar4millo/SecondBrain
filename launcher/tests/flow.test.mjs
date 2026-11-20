import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  coalesce,
  createTerminal,
  removeResponses,
  allowedSize,
} from "../harness.mjs";
import { openSessionRegistry } from "../sessions.mjs";
import { openWorkspaces } from "../workspaces.mjs";
import { createExecutor } from "../executor.mjs";
import { createItems } from "../items.mjs";
import { createLauncherServer } from "../index.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fingerprint = (token) => createHash("sha256").update(token).digest("hex");

test("el snapshot es un estado limpio aunque la salida llegue partida a mitad de una secuencia", async () => {
  const origin = createTerminal({ cols: 40, rows: 5 });
  origin.append("hola \x1b[3");
  origin.append("1mroja\x1b[0m\r\nsegunda línea");
  assert.equal(origin.seq, 2);
  const snapshot = await origin.snapshot();
  assert.equal(snapshot.seq, 2);
  assert.deepEqual([snapshot.cols, snapshot.rows], [40, 5]);
  assert.ok(!snapshot.datos.includes("\x1b[3\x1b"));
  // Playing the snapshot into a fresh screen reproduces the same state.
  const copy = createTerminal({ cols: 40, rows: 5 });
  copy.append(snapshot.datos);
  assert.equal((await copy.snapshot()).datos, snapshot.datos);
  assert.match(snapshot.datos, /hola .*roja/);
  assert.match(snapshot.datos, /segunda línea/);
});

test("el snapshot conserva el historial acotado y descarta el más antiguo", async () => {
  const terminal = createTerminal({ cols: 40, rows: 5, scrollback: 50 });
  for (let i = 1; i <= 200; i++) terminal.append(`línea ${i}\r\n`);
  const { datos: data, seq } = await terminal.snapshot();
  assert.equal(seq, 200);
  assert.match(data, /línea 200/);
  assert.match(data, /línea 160/);
  assert.doesNotMatch(data, /línea 1\r/);
  assert.doesNotMatch(data, /línea 100\r/);
});

test("un snapshot es coherente con exactamente los fragmentos hasta su seq", async () => {
  const terminal = createTerminal({ cols: 40, rows: 5 });
  terminal.append("uno\r\n");
  const pending = terminal.snapshot();
  terminal.append("dos\r\n");
  const snapshot = await pending;
  assert.equal(snapshot.seq, 1);
  assert.match(snapshot.datos, /uno/);
  assert.doesNotMatch(snapshot.datos, /dos/);
  assert.equal(terminal.seq, 2);
});

test("las respuestas a consultas de terminal no se reinyectan en el historial", async () => {
  assert.equal(
    removeResponses("a\x1b[?1;2cb\x1b[12;40Rc\x1b[>0;276;0cd\x1b[?2004;2$ye"),
    "abcde",
  );
  // Real queries are kept: the screen must still react to them.
  assert.equal(removeResponses("\x1b[c\x1b[6n"), "\x1b[c\x1b[6n");
  const terminal = createTerminal();
  terminal.append("\x1b[?1;2c");
  assert.equal(terminal.seq, 0);
});

test("la terminal avisa de fragmentos y cambios de tamaño a quien se suscribe", async () => {
  const terminal = createTerminal({ cols: 80, rows: 24 });
  const events = [];
  const baja = terminal.suscribir((e) => events.push(e));
  terminal.append("x");
  terminal.redimensionar(100, 30);
  terminal.redimensionar(100, 30);
  baja();
  terminal.append("y");
  assert.deepEqual(events, [
    { tipo: "salida", datos: "x", seq: 1 },
    { tipo: "tamano", cols: 100, rows: 30 },
  ]);
});

test("coalescencia: varios fragmentos cercanos viajan en un solo envío con su rango de seq", async () => {
  const lotes = [];
  const c = coalesce((batch) => lotes.push(batch), 15);
  c.agregar("a", 4);
  c.agregar("b", 5);
  c.agregar("c", 6);
  assert.equal(lotes.length, 0);
  await wait(60);
  assert.deepEqual(lotes, [{ datos: "abc", desde: 4, seq: 6 }]);
  c.agregar("d", 7);
  c.vaciar();
  assert.deepEqual(lotes[1], { datos: "d", desde: 7, seq: 7 });
  c.agregar("x".repeat(70000), 8);
  assert.equal(lotes.length, 3);
  c.agregar("z", 9);
  c.cancelar();
  await wait(40);
  assert.equal(lotes.length, 3);
});

test("el tamaño nunca baja de 80x24 ni sube de lo admitido", () => {
  assert.deepEqual(allowedSize(30, 10), { cols: 80, rows: 24 });
  assert.deepEqual(allowedSize(132, 43), { cols: 132, rows: 43 });
  assert.deepEqual(allowedSize(900, 900), { cols: 300, rows: 150 });
  assert.throws(() => allowedSize(80.5, 24));
  assert.throws(() => allowedSize("80", 24));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.escrito = [];
  child.stdin.on("data", (part) => {
    for (const line of part.toString().split("\n"))
      if (line) child.escrito.push(JSON.parse(line));
  });
  // A real process closes later, never before the launcher is listening.
  child.kill = () =>
    setTimeout(() => {
      child.stdout.end();
      child.emit("close", 0);
    }, 20);
  return child;
}

async function mount(t, { motor: engine = "claude", items } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-flujo-"));
  const registry = await openSessionRegistry(path.join(dir, "sesiones.json"));
  const spaces = await openWorkspaces({
    archivo: path.join(dir, "espacios.json"),
    proyectos: {},
    workspaces: path.join(dir, "workspaces"),
  });
  let child;
  const executor = createExecutor({
    registro: registry,
    espacios: spaces,
    proyectos: {},
    env: { PATH: process.env.PATH, HOME: dir },
    comandoInteractivo: () => ({ bin: "falso", args: [] }),
    lanzarPty: () => (child = fakeChild()),
  });
  const session = await executor.encargar({
    motor: engine,
    origen: "sala",
    espacioId: "p1",
    proyecto: "p1",
    harness: true,
    brief: "hola",
  });
  for (let i = 0; i < 100 && !child; i++) await wait(10);
  const server = createLauncherServer({
    registro: registry,
    ejecutor: executor,
    items: items?.({ registro: registry, dir }),
    controlHash: fingerprint("control"),
    hookHash: fingerprint("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // One hook, in order: streams, then the program, then the files.
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    if (executor.activos()) {
      await executor.cancelar(session.id);
      await executor.esperar(session.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    registro: registry,
    ejecutor: executor,
    sesion: session,
    hijo: child,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

/** Minimal SSE reader over fetch: yields {event, data} objects. */
async function readSse(response) {
  const lector = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  const events = [];
  const waits = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const blocks = rest.split("\n\n");
        rest = blocks.pop();
        for (const block of blocks) {
          const evento = /^event: (.*)$/m.exec(block)?.[1];
          const datos = /^data: (.*)$/m.exec(block)?.[1];
          if (evento) events.push({ evento, datos: JSON.parse(datos) });
        }
        for (const aviso of waits.splice(0)) aviso();
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    eventos: events,
    cerrar: () => lector.cancel().catch(() => {}),
    async hasta(condicion, ms = 3000) {
      const limit = Date.now() + ms;
      while (!condicion(events)) {
        if (Date.now() > limit)
          throw new Error(
            "Sin evento: " + JSON.stringify(events).slice(0, 500),
          );
        await Promise.race([new Promise((r) => waits.push(r)), wait(50)]);
      }
      return events;
    },
  };
}

const withAuth = { headers: { authorization: "Bearer control" } };

test("entrada: texto, interrumpir según motor y regla de tamaño con controlador", async (t) => {
  const {
    ejecutor: executor,
    sesion: session,
    hijo: child,
    registro: registry,
  } = await mount(t);
  child.stdout.write("bienvenida\r\n");
  for (
    let i = 0;
    i < 100 &&
    !(await executor.terminal(session.id)).datos.includes("bienvenida");
    i++
  )
    await wait(10);
  const before = (await executor.terminal(session.id)).cols;
  assert.equal(before, 120);
  // A secondary window, such as a phone, never resizes the shared program.
  assert.deepEqual(executor.entrada(session.id, { cols: 40, rows: 10 }), {
    ok: true,
    redimensionada: false,
  });
  assert.deepEqual(
    executor.entrada(session.id, { cols: 40, rows: 10, controlador: false }),
    { ok: true, redimensionada: false },
  );
  assert.equal(child.escrito.length, 0);
  // The controller can, but never below 80x24.
  assert.deepEqual(
    executor.entrada(session.id, { cols: 40, rows: 10, controlador: true }),
    { ok: true, redimensionada: true, cols: 80, rows: 24 },
  );
  assert.deepEqual(child.escrito.at(-1), { cols: 80, rows: 24 });
  const terminal = await executor.terminal(session.id);
  assert.deepEqual([terminal.cols, terminal.rows], [80, 24]);
  executor.entrada(session.id, { cols: 132, rows: 43, controlador: true });
  assert.deepEqual(child.escrito.at(-1), { cols: 132, rows: 43 });
  executor.entrada(session.id, { interrumpir: true });
  assert.deepEqual(child.escrito.at(-1), { raw: "\u001b" });
  executor.entrada(session.id, { texto: "Hola\nmundo" });
  assert.deepEqual(child.escrito.at(-1), { texto: "Hola\nmundo" });
  executor.entrada(session.id, { raw: "x" });
  for (const mala of [
    {},
    { raw: "x", texto: "y" },
    { texto: "   " },
    { texto: "x".repeat(60001) },
    { interrumpir: false },
    { cols: 80 },
  ])
    assert.throws(() => executor.entrada(session.id, mala), /inválid/);
  // A finished turn on a live program becomes work again when a message arrives.
  await registry.actualizar(session.id, { estado: "terminada" });
  executor.entrada(session.id, { texto: "otro" });
  for (let i = 0; i < 100 && registry.leer()[0].estado !== "trabajando"; i++)
    await wait(10);
  assert.equal(registry.leer()[0].estado, "trabajando");
});

test("interrumpir manda Ctrl+C a Codex", async (t) => {
  const {
    ejecutor: executor,
    sesion: session,
    hijo: child,
  } = await mount(t, { motor: "codex" });
  executor.entrada(session.id, { interrumpir: true });
  assert.deepEqual(child.escrito.at(-1), { raw: "\u0003" });
});

test("el stream exige credencial y rechaza sesiones sin terminal", async (t) => {
  const { url, sesion: session } = await mount(t);
  assert.equal(
    (await fetch(`${url}/sesiones/${session.id}/stream`)).status,
    401,
  );
  const desconocida = await fetch(
    `${url}/sesiones/f1111111-1111-4111-8111-111111111111/stream`,
    withAuth,
  );
  assert.equal(desconocida.status, 400);
  assert.equal((await desconocida.json()).error, "Terminal no disponible");
  assert.equal(
    (await fetch(`${url}/sesiones/no-es-uuid/stream`, withAuth)).status,
    404,
  );
  // The old cursor-based polling route is gone.
  assert.equal(
    (await fetch(`${url}/sesiones/${session.id}/terminal?cursor=0`, withAuth))
      .status,
    404,
  );
});

test("el stream envía snapshot, deltas coalescidos con seq continuo, items y estado", async (t) => {
  const {
    url,
    sesion,
    hijo: child,
    dir,
    registro: registry,
  } = await mount(t, {
    items: ({ registro, dir }) =>
      createItems({
        registro,
        env: { HOME: dir, AGENTES_CLAUDE_DIR: path.join(dir, "claude") },
        intervalo: 20,
      }),
  });
  // The follower reads the Claude transcript named after the session.
  const folder = path.join(dir, "claude/projects/-w");
  await mkdir(folder, { recursive: true });
  child.stdout.write("pantalla inicial\r\n");
  for (let i = 0; i < 100 && !registry.leer()[0].interactiva; i++)
    await wait(10);
  const controller = new AbortController();
  const response = await fetch(`${url}/sesiones/${sesion.id}/stream`, {
    ...withAuth,
    signal: controller.signal,
  });
  assert.equal(
    response.headers.get("content-type").split(";")[0],
    "text/event-stream",
  );
  const sse = await readSse(response);
  t.after(() => {
    controller.abort();
    return sse.cerrar();
  });
  await sse.hasta(
    (e) =>
      e.some((x) => x.evento === "snapshot") &&
      e.some((x) => x.evento === "items"),
  );
  const snapshot = sse.eventos.find((x) => x.evento === "snapshot").datos;
  assert.match(snapshot.datos, /pantalla inicial/);
  assert.equal(snapshot.activa, true);
  assert.equal(snapshot.cols, 120);
  assert.ok(snapshot.generacion);
  assert.ok(snapshot.seq >= 1);
  assert.deepEqual(sse.eventos.find((x) => x.evento === "items").datos, {
    reemplazar: true,
    items: [],
  });
  assert.equal(
    sse.eventos.find((x) => x.evento === "estado").datos.estado,
    "trabajando",
  );
  // Chunks written close together reach the reader as one delta.
  child.stdout.write("uno ");
  child.stdout.write("dos ");
  child.stdout.write("tres\r\n");
  await sse.hasta((e) =>
    e.some((x) => x.evento === "salida" && x.datos.datos.includes("tres")),
  );
  const salidas = sse.eventos
    .filter((x) => x.evento === "salida")
    .map((x) => x.datos);
  assert.equal(salidas.length, 1);
  assert.equal(salidas[0].datos, "uno dos tres\r\n");
  assert.equal(salidas[0].desde, snapshot.seq + 1);
  assert.equal(salidas[0].seq, snapshot.seq + 3);
  // The transcript becomes structured items while somebody is reading.
  await appendFile(
    path.join(folder, sesion.id + ".jsonl"),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/a" },
          },
        ],
      },
    }) + "\n",
  );
  await sse.hasta((e) => e.filter((x) => x.evento === "items").length >= 2);
  const incremental = sse.eventos.filter((x) => x.evento === "items")[1].datos;
  assert.equal(incremental.reemplazar, false);
  assert.equal(incremental.items[0].herramienta.nombre, "Read");
  // A state change reaches the reader without polling the session list.
  await registry.actualizar(sesion.id, { estado: "terminada" });
  await sse.hasta((e) =>
    e.some((x) => x.evento === "estado" && x.datos.estado === "terminada"),
  );
});

test("un cambio de tamaño del controlador entrega un snapshot nuevo", async (t) => {
  const { url, sesion: session, ejecutor: executor } = await mount(t);
  const controller = new AbortController();
  const sse = await readSse(
    await fetch(`${url}/sesiones/${session.id}/stream`, {
      ...withAuth,
      signal: controller.signal,
    }),
  );
  t.after(() => {
    controller.abort();
    return sse.cerrar();
  });
  await sse.hasta((e) => e.some((x) => x.evento === "snapshot"));
  executor.entrada(session.id, { cols: 100, rows: 30, controlador: true });
  await sse.hasta((e) => e.filter((x) => x.evento === "snapshot").length === 2);
  const [, segundo] = sse.eventos.filter((x) => x.evento === "snapshot");
  assert.deepEqual([segundo.datos.cols, segundo.datos.rows], [100, 30]);
});

test("al terminar el programa el stream avisa y una sesión guardada entrega su última pantalla", async (t) => {
  const {
    url,
    sesion: session,
    hijo: child,
    ejecutor: executor,
    registro: registry,
  } = await mount(t);
  child.stdout.write("adiós\r\n");
  const controller = new AbortController();
  const sse = await readSse(
    await fetch(`${url}/sesiones/${session.id}/stream`, {
      ...withAuth,
      signal: controller.signal,
    }),
  );
  t.after(() => {
    controller.abort();
    return sse.cerrar();
  });
  // The output must be on screen before the program ends, as with a real one.
  await sse.hasta((e) =>
    e.some(
      (x) =>
        (x.evento === "snapshot" || x.evento === "salida") &&
        x.datos.datos.includes("adiós"),
    ),
  );
  await executor.cancelar(session.id);
  await executor.esperar(session.id);
  await sse.hasta((e) =>
    e.some(
      (x) =>
        x.evento === "estado" &&
        x.datos.activa === false &&
        x.datos.estado === "cancelada",
    ),
  );
  const persistida = await executor.terminal(session.id);
  assert.match(persistida.datos, /adiós/);
  assert.match(registry.leer()[0].terminal, /adiós/);
});
