import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Auth, totp } from "../auth.mjs";
import { Failure, Vault } from "../vault.mjs";
import { createSharedFiles } from "../shared-files.mjs";
import { crearColaAprobaciones } from "../approvals.mjs";
import { createMundo } from "../world.mjs";
import { createApplication } from "../index.mjs";

process.env.SB_REFERENCE_BANK = fileURLToPath(
  new URL("./fixtures/reference-bank.json", import.meta.url),
);

async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function appFixture(t) {
  const dir = await temp(t);
  const root = path.join(dir, "vault");
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Sintético\n");
  const records = [];
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    logger: (r) => records.push(r),
    agentes: { brainToken: "synthetic-room" },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const token = (
    await readFile(path.join(dir, "data", "agent-token"), "utf8")
  ).trim();
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const call = (route, body) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, root, dir, call, records };
}
test("distingue JSON válido con campos inválidos", async (t) => {
  const { call } = await appFixture(t);
  const r = await call("/vault/note", { path: 3 });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Cuerpo de petición inválido/);
  assert.match(body.error, /path/);
});
test("GET y POST conservan hash y contenido", async (t) => {
  const { call } = await appFixture(t);
  const r = await call("/vault/note", {
    path: "00-Inbox/Prueba.md",
    content: "# Prueba\n",
    expectedHash: null,
  });
  assert.equal(r.status, 200);
  const note = await (
    await call("/vault/note?path=00-Inbox%2FPrueba.md")
  ).json();
  assert.equal(note.content, "# Prueba\n");
  assert.equal(typeof note.hash, "string");
});
test("archivo desaparecido devuelve 404 y mantiene el servidor", async (t) => {
  const { call, dir } = await appFixture(t);
  const entry = await (
    await call("/files", {
      area: "de-agentes",
      name: "hola.txt",
      content: "hola",
      encoding: "utf8",
    })
  ).json();
  await rm(path.join(dir, "data", "shared", "de-agentes", entry.id));
  assert.equal((await call("/files/download?id=" + entry.id)).status, 404);
  assert.equal((await call("/health")).status, 200);
});
test("rechaza rangos negativos o fraccionarios antes de leer", async (t) => {
  const { call } = await appFixture(t);
  for (const range of [
    "length=-5",
    "offset=-1",
    "length=1.5",
    "length=1048577",
  ])
    assert.equal((await call("/files/chunk?id=missing&" + range)).status, 400);
});
test("registra mensaje y pila sin devolverlos al cliente", async (t) => {
  const { call, app, records } = await appFixture(t);
  app.finance.overview = async () => {
    throw new Error("diagnóstico sintético");
  };
  const r = await call("/finance/overview");
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /diagnóstico/);
  const record = records.find((r) => r.event === "http.error");
  assert.match(record.message, /diagnóstico/);
  assert.match(record.stack, /Error:/);
});
test("CSP permite recursos de la app y bloquea marcos externos", async (t) => {
  const { call } = await appFixture(t);
  const policy = (await call("/health")).headers.get("content-security-policy");
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /worker-src 'self'/);
});
test("acepta TOTP con espacios y rechaza reutilización incluso tras reinicio", async (t) => {
  const dir = await temp(t);
  const auth = new Auth(dir);
  await auth.init();
  const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const response = { getHeader: () => undefined, setHeader: () => {} };
  await auth.setup(
    { username: "test", password: "synthetic-long-password" },
    request,
    response,
  );
  auth.state.totpSecret = "JBSWY3DPEHPK3PXP";
  const code = totp(auth.state.totpSecret);
  const body = {
    username: "test",
    password: "synthetic-long-password",
    code: code.slice(0, 3) + " " + code.slice(3),
  };
  assert.equal((await auth.verifyCredentials(body, request)).ok, true);
  const restarted = new Auth(dir);
  await restarted.init();
  await assert.rejects(
    restarted.verifyCredentials({ ...body, code }, request),
    { status: 401 },
  );
});
test("recupera solo la última línea truncada y compacta el journal", async (t) => {
  const dir = await temp(t);
  const file = path.join(dir, "aprobaciones.jsonl");
  const old = {
    id: "antigua",
    estado: "rechazada",
    creada: 1,
    resuelta: 2,
    vence: 3,
  };
  const current = {
    id: "reciente",
    estado: "rechazada",
    creada: 10000000000,
    resuelta: 10000000001,
    vence: 10000000002,
  };
  await writeFile(
    file,
    JSON.stringify(old) +
      "\n" +
      JSON.stringify(current) +
      "\n" +
      JSON.stringify(current) +
      '\n{"id":',
  );
  const cola = await crearColaAprobaciones(dir, { reloj: () => 10000000003 });
  t.after(() => cola.cerrar());
  assert.deepEqual(
    cola.listar().map((r) => r.id),
    ["reciente"],
  );
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
});
test("no oculta corrupción en medio del journal", async (t) => {
  const dir = await temp(t);
  await writeFile(
    path.join(dir, "aprobaciones.jsonl"),
    'incorrecto\n{"id":"a","estado":"rechazada"}\n',
  );
  await assert.rejects(crearColaAprobaciones(dir));
});
test("rechaza metadatos de subida sin consumir cuerpo", async (t) => {
  const dir = await temp(t);
  const shared = createSharedFiles(dir, Failure);
  let consumed = false;
  const stream = Readable.from(
    (async function* () {
      consumed = true;
      yield Buffer.from("contenido");
    })(),
  );
  await assert.rejects(
    shared.putStream({ area: "inexistente", name: "x.txt", stream }),
    { status: 400 },
  );
  assert.equal(consumed, false);
});
test("serializa guardados concurrentes de Mundo sin perder agentes", async (t) => {
  const dir = await temp(t);
  await mkdir(path.join(dir, "mundo"));
  await writeFile(
    path.join(dir, "mundo", "paquete.json"),
    JSON.stringify({
      formato: 1,
      agents: ["ambar", "menta", "lira", "marina"].map((id) => ({ id })),
    }),
  );
  const mundo = createMundo(dir, Failure);
  await mundo.configurarAgente({ id: "ambar", enabled: true, notes: "inicio" });
  await Promise.all(
    ["ambar", "menta", "lira", "marina"].map((id) =>
      mundo.configurarAgente({ id, enabled: true, notes: id }),
    ),
  );
  const data = JSON.parse(
    await readFile(path.join(dir, "mundo-estado.json"), "utf8"),
  );
  assert.equal(Object.keys(data.agents).length, 4);
});
test("valida finanzas sin escribir y conserva idempotencia al recrear Finance", async (t) => {
  const { app, call, root } = await appFixture(t);
  await assert.rejects(
    app.finance.validate({ op: "desconocida" }, "2026-11-09"),
    { status: 404 },
  );
  assert.equal((await app.finance.overview("2026-11-09")).configured, false);
  const op = { op: "init", requestId: "synthetic-restart-id" };
  const first = await (await call("/finance/ops", op)).json();
  const { Finance } = await import("../finance.mjs");
  const restarted = new Finance(new Vault(root));
  assert.deepEqual(await restarted.run(op, first.overview.today), first);
});
test("fecha de notas usa el día de México al cruzar medianoche UTC", async (t) => {
  const dir = await temp(t);
  await mkdir(path.join(dir, "00-Inbox"));
  const vault = new Vault(dir);
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-10T02:00:00Z"),
  });
  const { randomUUID } = await import("node:crypto");
  await vault.mutate({
    mutationId: randomUUID(),
    baseVersion: 0,
    entity: {
      id: randomUUID(),
      kind: "note",
      title: "Fecha sintética",
      status: "active",
    },
  });
  const snapshot = await vault.snapshot();
  const source = await readFile(
    path.join(dir, [...snapshot.records.values()][0].relative),
    "utf8",
  );
  assert.match(source, /updated: 2026-11-09/);
});

test(
  "recupera un PID reutilizado con otro inicio de proceso",
  { skip: process.platform !== "linux" },
  async (t) => {
    const dir = await temp(t);
    await writeFile(
      path.join(dir, "instance.lock"),
      JSON.stringify({
        pid: process.pid,
        nonce: "stale",
        started: "wrong-start",
      }),
    );
    const { acquireInstance } = await import("../instance.mjs");
    const release = await acquireInstance(dir);
    await release();
  },
);
test("elimina claves de límites de intentos caducadas", async () => {
  const auth = new Auth("unused");
  auth.rates.set("expired", [1]);
  auth.rates.set("live", [Date.now()]);
  auth.prune();
  assert.equal(auth.rates.has("expired"), false);
  assert.equal(auth.rates.has("live"), true);
});
test("limita bytes de imágenes remotas de Pinterest", async (t) => {
  const dir = await temp(t);
  const { createSala } = await import("../room.mjs");
  const sala = await createSala(dir, Failure);
  const pin = sala
    .leer()
    .pines.find((p) => p.imagen.startsWith("https://i.pinimg.com/"));
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array(6 * 1024 * 1024)),
  );
  await assert.rejects(sala.imagen(pin.id, { writeHead() {}, end() {} }), {
    status: 502,
  });
});
test("una operación de sala inválida se rechaza sin pedir aprobación y un reintento aplicado no pide otra", async (t) => {
  const { app, call } = await appFixture(t);
  const url = `http://127.0.0.1:${app.server.address().port}/api/v1/finance/ops`;
  const room = (body) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-room",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  assert.equal(
    (
      await room({
        op: "charge",
        card: "missing",
        amount: 10,
        desc: "sintético",
      })
    ).status,
    404,
  );
  assert.deepEqual(await (await call("/aprobaciones")).json(), []);
  const op = { op: "init", requestId: "already-applied" };
  assert.equal((await call("/finance/ops", op)).status, 200);
  assert.equal((await room(op)).status, 200);
  assert.deepEqual(await (await call("/aprobaciones")).json(), []);
});
test("un cargo reintentado tras reiniciar no duplica saldo ni movimientos", async (t) => {
  const { app, root, call } = await appFixture(t);
  const day = "2026-11-09";
  await app.finance.run({ op: "init" }, day);
  await app.finance.run(
    {
      op: "card-add",
      name: "Sintética",
      id: "synthetic",
      limit: 1000,
      balance: 0,
    },
    day,
  );
  const op = {
    op: "charge",
    card: "Sintética",
    amount: 10,
    desc: "Cargo sintético",
    requestId: "charge-once",
  };
  const first = await app.finance.run(op, day);
  const { Finance } = await import("../finance.mjs");
  const restarted = new Finance(new Vault(root));
  assert.deepEqual(
    JSON.parse(JSON.stringify(await restarted.run(op, day))),
    JSON.parse(JSON.stringify(first)),
  );
  const view = await restarted.overview(day);
  assert.equal(view.transactions.length, 1);
  assert.equal(view.cards[0].balanceMinor, 1000);
  const items = await (await call("/items")).json();
  assert.doesNotMatch(JSON.stringify(items), /financeReceipts|charge-once/);
});
