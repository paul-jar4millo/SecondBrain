import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  coalescer,
  crearTerminal,
  quitarRespuestas,
  tamanoPermitido,
} from "../harness.mjs";
import { abrirRegistro } from "../sesiones.mjs";
import { abrirEspacios } from "../espacios.mjs";
import { crearEjecutor } from "../ejecucion.mjs";
import { crearItems } from "../items.mjs";
import { crearServidor } from "../index.mjs";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const huella = (token) => createHash("sha256").update(token).digest("hex");

test("el snapshot es un estado limpio aunque la salida llegue partida a mitad de una secuencia", async () => {
  const origen = crearTerminal({ cols: 40, rows: 5 });
  origen.append("hola \x1b[3");
  origen.append("1mroja\x1b[0m\r\nsegunda línea");
  assert.equal(origen.seq, 2);
  const snapshot = await origen.snapshot();
  assert.equal(snapshot.seq, 2);
  assert.deepEqual([snapshot.cols, snapshot.rows], [40, 5]);
  assert.ok(!snapshot.datos.includes("\x1b[3\x1b"));
  // Playing the snapshot into a fresh screen reproduces the same state.
  const copia = crearTerminal({ cols: 40, rows: 5 });
  copia.append(snapshot.datos);
  assert.equal((await copia.snapshot()).datos, snapshot.datos);
  assert.match(snapshot.datos, /hola .*roja/);
  assert.match(snapshot.datos, /segunda línea/);
});

test("el snapshot conserva el historial acotado y descarta el más antiguo", async () => {
  const terminal = crearTerminal({ cols: 40, rows: 5, scrollback: 50 });
  for (let i = 1; i <= 200; i++) terminal.append(`línea ${i}\r\n`);
  const { datos, seq } = await terminal.snapshot();
  assert.equal(seq, 200);
  assert.match(datos, /línea 200/);
  assert.match(datos, /línea 160/);
  assert.doesNotMatch(datos, /línea 1\r/);
  assert.doesNotMatch(datos, /línea 100\r/);
});

test("un snapshot es coherente con exactamente los fragmentos hasta su seq", async () => {
  const terminal = crearTerminal({ cols: 40, rows: 5 });
  terminal.append("uno\r\n");
  const pendiente = terminal.snapshot();
  terminal.append("dos\r\n");
  const snapshot = await pendiente;
  assert.equal(snapshot.seq, 1);
  assert.match(snapshot.datos, /uno/);
  assert.doesNotMatch(snapshot.datos, /dos/);
  assert.equal(terminal.seq, 2);
});

test("las respuestas a consultas de terminal no se reinyectan en el historial", async () => {
  assert.equal(
    quitarRespuestas("a\x1b[?1;2cb\x1b[12;40Rc\x1b[>0;276;0cd\x1b[?2004;2$ye"),
    "abcde",
  );
  // Real queries are kept: the screen must still react to them.
  assert.equal(quitarRespuestas("\x1b[c\x1b[6n"), "\x1b[c\x1b[6n");
  const terminal = crearTerminal();
  terminal.append("\x1b[?1;2c");
  assert.equal(terminal.seq, 0);
});

test("la terminal avisa de fragmentos y cambios de tamaño a quien se suscribe", async () => {
  const terminal = crearTerminal({ cols: 80, rows: 24 });
  const eventos = [];
  const baja = terminal.suscribir((e) => eventos.push(e));
  terminal.append("x");
  terminal.redimensionar(100, 30);
  terminal.redimensionar(100, 30);
  baja();
  terminal.append("y");
  assert.deepEqual(eventos, [
    { tipo: "salida", datos: "x", seq: 1 },
    { tipo: "tamano", cols: 100, rows: 30 },
  ]);
});

test("coalescencia: varios fragmentos cercanos viajan en un solo envío con su rango de seq", async () => {
  const lotes = [];
  const c = coalescer((lote) => lotes.push(lote), 15);
  c.agregar("a", 4);
  c.agregar("b", 5);
  c.agregar("c", 6);
  assert.equal(lotes.length, 0);
  await espera(60);
  assert.deepEqual(lotes, [{ datos: "abc", desde: 4, seq: 6 }]);
  c.agregar("d", 7);
  c.vaciar();
  assert.deepEqual(lotes[1], { datos: "d", desde: 7, seq: 7 });
  c.agregar("x".repeat(70000), 8);
  assert.equal(lotes.length, 3);
  c.agregar("z", 9);
  c.cancelar();
  await espera(40);
  assert.equal(lotes.length, 3);
});

test("el tamaño nunca baja de 80x24 ni sube de lo admitido", () => {
  assert.deepEqual(tamanoPermitido(30, 10), { cols: 80, rows: 24 });
  assert.deepEqual(tamanoPermitido(132, 43), { cols: 132, rows: 43 });
  assert.deepEqual(tamanoPermitido(900, 900), { cols: 300, rows: 150 });
  assert.throws(() => tamanoPermitido(80.5, 24));
  assert.throws(() => tamanoPermitido("80", 24));
});

function falsoHijo() {
  const hijo = new EventEmitter();
  hijo.stdin = new PassThrough();
  hijo.stdout = new PassThrough();
  hijo.stderr = new PassThrough();
  hijo.escrito = [];
  hijo.stdin.on("data", (parte) => {
    for (const linea of parte.toString().split("\n"))
      if (linea) hijo.escrito.push(JSON.parse(linea));
  });
  // A real process closes later, never before the launcher is listening.
  hijo.kill = () =>
    setTimeout(() => {
      hijo.stdout.end();
      hijo.emit("close", 0);
    }, 20);
  return hijo;
}

async function montar(t, { motor = "claude", items } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-flujo-"));
  const registro = await abrirRegistro(path.join(dir, "sesiones.json"));
  const espacios = await abrirEspacios({
    archivo: path.join(dir, "espacios.json"),
    proyectos: {},
    workspaces: path.join(dir, "workspaces"),
  });
  let hijo;
  const ejecutor = crearEjecutor({
    registro,
    espacios,
    proyectos: {},
    env: { PATH: process.env.PATH, HOME: dir },
    comandoInteractivo: () => ({ bin: "falso", args: [] }),
    lanzarPty: () => (hijo = falsoHijo()),
  });
  const sesion = await ejecutor.encargar({
    motor,
    origen: "sala",
    espacioId: "p1",
    proyecto: "p1",
    harness: true,
    brief: "hola",
  });
  for (let i = 0; i < 100 && !hijo; i++) await espera(10);
  const servidor = crearServidor({
    registro,
    ejecutor,
    items: items?.({ registro, dir }),
    controlHash: huella("control"),
    hookHash: huella("hook"),
  });
  servidor.listen(0, "127.0.0.1");
  await once(servidor, "listening");
  // One hook, in order: streams, then the program, then the files.
  t.after(async () => {
    servidor.closeAllConnections();
    servidor.close();
    if (ejecutor.activos()) {
      await ejecutor.cancelar(sesion.id);
      await ejecutor.esperar(sesion.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    registro,
    ejecutor,
    sesion,
    hijo,
    url: `http://127.0.0.1:${servidor.address().port}`,
  };
}

/** Minimal SSE reader over fetch: yields {event, data} objects. */
async function leerSse(respuesta) {
  const lector = respuesta.body.getReader();
  const decoder = new TextDecoder();
  let resto = "";
  const eventos = [];
  const esperas = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        resto += decoder.decode(value, { stream: true });
        const bloques = resto.split("\n\n");
        resto = bloques.pop();
        for (const bloque of bloques) {
          const evento = /^event: (.*)$/m.exec(bloque)?.[1];
          const datos = /^data: (.*)$/m.exec(bloque)?.[1];
          if (evento) eventos.push({ evento, datos: JSON.parse(datos) });
        }
        for (const aviso of esperas.splice(0)) aviso();
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    eventos,
    cerrar: () => lector.cancel().catch(() => {}),
    async hasta(condicion, ms = 3000) {
      const limite = Date.now() + ms;
      while (!condicion(eventos)) {
        if (Date.now() > limite)
          throw new Error(
            "Sin evento: " + JSON.stringify(eventos).slice(0, 500),
          );
        await Promise.race([new Promise((r) => esperas.push(r)), espera(50)]);
      }
      return eventos;
    },
  };
}

const conAuth = { headers: { authorization: "Bearer control" } };

test("entrada: texto, interrumpir según motor y regla de tamaño con controlador", async (t) => {
  const { ejecutor, sesion, hijo, registro } = await montar(t);
  hijo.stdout.write("bienvenida\r\n");
  for (
    let i = 0;
    i < 100 &&
    !(await ejecutor.terminal(sesion.id)).datos.includes("bienvenida");
    i++
  )
    await espera(10);
  const antes = (await ejecutor.terminal(sesion.id)).cols;
  assert.equal(antes, 120);
  // A secondary window, such as a phone, never resizes the shared program.
  assert.deepEqual(ejecutor.entrada(sesion.id, { cols: 40, rows: 10 }), {
    ok: true,
    redimensionada: false,
  });
  assert.deepEqual(
    ejecutor.entrada(sesion.id, { cols: 40, rows: 10, controlador: false }),
    { ok: true, redimensionada: false },
  );
  assert.equal(hijo.escrito.length, 0);
  // The controller can, but never below 80x24.
  assert.deepEqual(
    ejecutor.entrada(sesion.id, { cols: 40, rows: 10, controlador: true }),
    { ok: true, redimensionada: true, cols: 80, rows: 24 },
  );
  assert.deepEqual(hijo.escrito.at(-1), { cols: 80, rows: 24 });
  const terminal = await ejecutor.terminal(sesion.id);
  assert.deepEqual([terminal.cols, terminal.rows], [80, 24]);
  ejecutor.entrada(sesion.id, { cols: 132, rows: 43, controlador: true });
  assert.deepEqual(hijo.escrito.at(-1), { cols: 132, rows: 43 });
  ejecutor.entrada(sesion.id, { interrumpir: true });
  assert.deepEqual(hijo.escrito.at(-1), { raw: "\u001b" });
  ejecutor.entrada(sesion.id, { texto: "Hola\nmundo" });
  assert.deepEqual(hijo.escrito.at(-1), { texto: "Hola\nmundo" });
  ejecutor.entrada(sesion.id, { raw: "x" });
  for (const mala of [
    {},
    { raw: "x", texto: "y" },
    { texto: "   " },
    { texto: "x".repeat(60001) },
    { interrumpir: false },
    { cols: 80 },
  ])
    assert.throws(() => ejecutor.entrada(sesion.id, mala), /inválid/);
  // A finished turn on a live program becomes work again when a message arrives.
  await registro.actualizar(sesion.id, { estado: "terminada" });
  ejecutor.entrada(sesion.id, { texto: "otro" });
  for (let i = 0; i < 100 && registro.leer()[0].estado !== "trabajando"; i++)
    await espera(10);
  assert.equal(registro.leer()[0].estado, "trabajando");
});

test("interrumpir manda Ctrl+C a Codex", async (t) => {
  const { ejecutor, sesion, hijo } = await montar(t, { motor: "codex" });
  ejecutor.entrada(sesion.id, { interrumpir: true });
  assert.deepEqual(hijo.escrito.at(-1), { raw: "\u0003" });
});

test("el stream exige credencial y rechaza sesiones sin terminal", async (t) => {
  const { url, sesion } = await montar(t);
  assert.equal(
    (await fetch(`${url}/sesiones/${sesion.id}/stream`)).status,
    401,
  );
  const desconocida = await fetch(
    `${url}/sesiones/f1111111-1111-4111-8111-111111111111/stream`,
    conAuth,
  );
  assert.equal(desconocida.status, 400);
  assert.equal((await desconocida.json()).error, "Terminal no disponible");
  assert.equal(
    (await fetch(`${url}/sesiones/no-es-uuid/stream`, conAuth)).status,
    404,
  );
  // The old cursor-based polling route is gone.
  assert.equal(
    (await fetch(`${url}/sesiones/${sesion.id}/terminal?cursor=0`, conAuth))
      .status,
    404,
  );
});

test("el stream envía snapshot, deltas coalescidos con seq continuo, items y estado", async (t) => {
  const { url, sesion, hijo, dir, registro } = await montar(t, {
    items: ({ registro, dir }) =>
      crearItems({
        registro,
        env: { HOME: dir, AGENTES_CLAUDE_DIR: path.join(dir, "claude") },
        intervalo: 20,
      }),
  });
  // The follower reads the Claude transcript named after the session.
  const carpeta = path.join(dir, "claude/projects/-w");
  await mkdir(carpeta, { recursive: true });
  hijo.stdout.write("pantalla inicial\r\n");
  for (let i = 0; i < 100 && !registro.leer()[0].interactiva; i++)
    await espera(10);
  const controlador = new AbortController();
  const respuesta = await fetch(`${url}/sesiones/${sesion.id}/stream`, {
    ...conAuth,
    signal: controlador.signal,
  });
  assert.equal(
    respuesta.headers.get("content-type").split(";")[0],
    "text/event-stream",
  );
  const sse = await leerSse(respuesta);
  t.after(() => {
    controlador.abort();
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
  hijo.stdout.write("uno ");
  hijo.stdout.write("dos ");
  hijo.stdout.write("tres\r\n");
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
    path.join(carpeta, sesion.id + ".jsonl"),
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
  await registro.actualizar(sesion.id, { estado: "terminada" });
  await sse.hasta((e) =>
    e.some((x) => x.evento === "estado" && x.datos.estado === "terminada"),
  );
});

test("un cambio de tamaño del controlador entrega un snapshot nuevo", async (t) => {
  const { url, sesion, ejecutor } = await montar(t);
  const controlador = new AbortController();
  const sse = await leerSse(
    await fetch(`${url}/sesiones/${sesion.id}/stream`, {
      ...conAuth,
      signal: controlador.signal,
    }),
  );
  t.after(() => {
    controlador.abort();
    return sse.cerrar();
  });
  await sse.hasta((e) => e.some((x) => x.evento === "snapshot"));
  ejecutor.entrada(sesion.id, { cols: 100, rows: 30, controlador: true });
  await sse.hasta((e) => e.filter((x) => x.evento === "snapshot").length === 2);
  const [, segundo] = sse.eventos.filter((x) => x.evento === "snapshot");
  assert.deepEqual([segundo.datos.cols, segundo.datos.rows], [100, 30]);
});

test("al terminar el programa el stream avisa y una sesión guardada entrega su última pantalla", async (t) => {
  const { url, sesion, hijo, ejecutor, registro } = await montar(t);
  hijo.stdout.write("adiós\r\n");
  const controlador = new AbortController();
  const sse = await leerSse(
    await fetch(`${url}/sesiones/${sesion.id}/stream`, {
      ...conAuth,
      signal: controlador.signal,
    }),
  );
  t.after(() => {
    controlador.abort();
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
  await ejecutor.cancelar(sesion.id);
  await ejecutor.esperar(sesion.id);
  await sse.hasta((e) =>
    e.some(
      (x) =>
        x.evento === "estado" &&
        x.datos.activa === false &&
        x.datos.estado === "cancelada",
    ),
  );
  const persistida = await ejecutor.terminal(sesion.id);
  assert.match(persistida.datos, /adiós/);
  assert.match(registro.leer()[0].terminal, /adiós/);
});
