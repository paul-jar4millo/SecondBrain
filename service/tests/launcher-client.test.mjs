import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createLanzador } from "../launcher-client.mjs";
import { createApplication } from "../index.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

class Failure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

test("reenvía consultas y encargos al lanzador autenticado sin exponer el token", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/estado" ? '[{"id":"s"}]' : '{"id":"s"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const cliente = createLanzador(Failure, {
    url: `http://127.0.0.1:${server.address().port}`,
    token: "secreto",
  });
  assert.deepEqual(await cliente.leer(), [{ id: "s" }]);
  assert.deepEqual(await cliente.encargar({ motor: "codex", brief: "x" }), {
    id: "s",
  });
  await cliente.cancelar("f1111111-1111-4111-8111-111111111111");
  await cliente.eliminar("f1111111-1111-4111-8111-111111111111");
  await cliente.espacios();
  await cliente.espacios({ id: "p1", repositorio: null, revision: 0 });
  await cliente.entrada({
    id: "f1111111-1111-4111-8111-111111111111",
    raw: "x",
  });
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      "/estado",
      "/sesiones",
      "/sesiones/f1111111-1111-4111-8111-111111111111/cancelar",
      "/sesiones/f1111111-1111-4111-8111-111111111111/eliminar",
      "/espacios",
      "/espacios",
      "/sesiones/f1111111-1111-4111-8111-111111111111/terminal",
    ],
  );
  assert.ok(requests.every((r) => r.auth === "Bearer secreto"));
  assert.ok(requests.every((r) => !r.body.includes("secreto")));
  await assert.rejects(cliente.cancelar("../estado"));
  await assert.rejects(cliente.eliminar("../estado"));
  await assert.rejects(cliente.flujo("../estado"), { status: 400 });
});

test("las rutas del lanzador mantienen CSRF y niegan la credencial de sala", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/estado" ? "[]" : '{"id":"ok"}');
  });
  runner.listen(0, "127.0.0.1");
  await once(runner, "listening");
  t.after(() => runner.close());
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Test\n");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${runner.address().port}`,
      token: "control",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  assert.equal((await fetch(base + "/agentes/sesiones")).status, 200);
  for (const route of [
    "/agentes/espacios",
    "/agentes/terminal/stream?id=f1111111-1111-4111-8111-111111111111",
    "/agentes/terminal/entrada",
  ]) {
    assert.equal(
      (
        await fetch(base + route, {
          method: route.endsWith("entrada") ? "POST" : "GET",
          headers: { authorization: "Bearer room-secret" },
          ...(route.endsWith("entrada") ? { body: "{}" } : {}),
        })
      ).status,
      403,
    );
  }
  assert.equal((await fetch(base + "/agentes/proyectos-lanzador")).status, 200);
  assert.equal(
    (
      await fetch(base + "/agentes/proyectos-lanzador", {
        headers: { authorization: "Bearer room-secret" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/agentes/sesiones", {
        headers: { authorization: "Bearer room-secret" },
      })
    ).status,
    403,
  );
  const payload = JSON.stringify({
    motor: "codex",
    origen: "sala",
    proyecto: "prueba",
    brief: "hola",
  });
  assert.equal(
    (await fetch(base + "/agentes/sesiones", { method: "POST", body: payload }))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/equipo/estado", {
        method: "POST",
        headers: {
          authorization: "Bearer room-secret",
          "content-type": "application/json",
          "x-sb-agente": "menta",
          "x-sb-sesion": "a1111111-1111-4111-8111-111111111111",
        },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/equipo/estado", {
        method: "POST",
        headers: {
          authorization: "Bearer room-secret",
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const csrf = await fetch(base + "/auth/csrf");
  const { token } = await csrf.json();
  const headers = {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  assert.equal(
    (
      await fetch(base + "/agentes/sesiones", {
        method: "POST",
        body: payload,
        headers,
      })
    ).status,
    202,
  );
});

test("el stream de la terminal se reenvía sin buffer, exige UUID y se cierra en ambos sentidos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const abiertas = [];
  const requests = [];
  let cierreUpstream;
  const cerrado = new Promise((resolve) => (cierreUpstream = resolve));
  const runner = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.write(": connected\n\n");
    }
    if (req.url.startsWith("/sesiones/e1111111")) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end('{"error":"Terminal no disponible"}');
    }
    if (req.url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: snapshot\ndata: {"datos":"hola"}\n\n');
      abiertas.push(res);
      res.on("close", cierreUpstream);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  runner.listen(0, "127.0.0.1");
  await once(runner, "listening");
  t.after(() => {
    runner.closeAllConnections();
    runner.close();
  });
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Test\n");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    lanzador: {
      url: `http://127.0.0.1:${runner.address().port}`,
      token: "control",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => {
    app.server.closeAllConnections();
    return app.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const id = "a1111111-1111-4111-8111-111111111111";
  for (const query of ["", "?id=no-es-uuid", `?id=${id}&otro=1`])
    assert.equal(
      (await fetch(`${base}/agentes/terminal/stream${query}`)).status,
      400,
    );
  assert.equal(
    (
      await fetch(
        `${base}/agentes/terminal/stream?id=e1111111-1111-4111-8111-111111111111`,
      )
    ).status,
    400,
  );
  const controller = new AbortController();
  const respuesta = await fetch(`${base}/agentes/terminal/stream?id=${id}`, {
    signal: controller.signal,
  });
  assert.equal(respuesta.status, 200);
  assert.match(respuesta.headers.get("content-type"), /text\/event-stream/);
  assert.match(respuesta.headers.get("cache-control"), /no-cache/);
  const lector = respuesta.body.getReader();
  // The first event arrives while the upstream connection is still open.
  const primero = new TextDecoder().decode((await lector.read()).value);
  assert.match(primero, /event: snapshot/);
  abiertas[0].write('event: salida\ndata: {"datos":"x","desde":1,"seq":1}\n\n');
  assert.match(
    new TextDecoder().decode((await lector.read()).value),
    /event: salida/,
  );
  const stream = requests.find((r) => r.url === `/sesiones/${id}/stream`);
  assert.equal(stream.auth, "Bearer control");
  // The browser leaving closes the launcher's stream.
  controller.abort();
  await cerrado;
  // The launcher ending closes the browser's stream.
  const segunda = await fetch(`${base}/agentes/terminal/stream?id=${id}`);
  const lectorSegunda = segunda.body.getReader();
  await lectorSegunda.read();
  abiertas.at(-1).end();
  for (;;) if ((await lectorSegunda.read()).done) break;
});

test("diff, revertir, PR y capacidades: validan con zod, exigen CSRF, niegan la sala y reenvían el aviso del lanzador", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-gateway-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = "a1111111-1111-4111-8111-111111111111";
  const recibidas = [];
  const runner = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    recibidas.push({
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/revertir")) {
      res.statusCode = 409;
      return res.end(
        '{"error":"Detén el turno antes de revertir","seguro":true}',
      );
    }
    if (req.url.endsWith("/pr/redactar")) {
      res.statusCode = 502;
      return res.end('{"error":"mensaje interno con /ruta/secreta"}');
    }
    res.end('{"ok":true}');
  });
  runner.listen(0, "127.0.0.1");
  await once(runner, "listening");
  t.after(() => runner.close());
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Test\n");
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${runner.address().port}`,
      token: "control",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const csrf = await fetch(base + "/auth/csrf");
  const { token } = await csrf.json();
  const headers = {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  const get = (ruta, extra = {}) => fetch(base + ruta, extra);
  const post = (ruta, cuerpo, h = headers) =>
    fetch(base + ruta, {
      method: "POST",
      headers: h,
      body: JSON.stringify(cuerpo),
    });

  assert.equal(
    (await get(`/agentes/sesiones/diff?id=${id}&desde=2&hasta=actual`)).status,
    200,
  );
  assert.equal(
    (await get(`/agentes/sesiones/diff?id=${id}&desde=x`)).status,
    400,
  );
  assert.equal((await get(`/agentes/sesiones/diff?id=no`)).status, 400);
  assert.equal(
    (await get(`/agentes/sesiones/diff?id=${id}&otro=1`)).status,
    400,
  );
  assert.equal(
    (await get(`/agentes/sesiones/pr/propuesta?id=${id}`)).status,
    200,
  );
  assert.equal((await get("/agentes/capacidades")).status, 200);
  assert.deepEqual(
    recibidas.map((r) => r.url).filter((u) => u !== "/events"),
    [
      `/sesiones/${id}/diff?desde=2&hasta=actual`,
      `/sesiones/${id}/pr/propuesta`,
      "/capacidades",
    ],
  );

  // Writes need the CSRF token and a user session, never the room credential.
  const sinCsrf = { "content-type": "application/json" };
  assert.equal(
    (await post("/agentes/sesiones/revertir", { id, n: 1 }, sinCsrf)).status,
    400,
  );
  for (const ruta of [
    `/agentes/sesiones/diff?id=${id}`,
    "/agentes/capacidades",
    `/agentes/sesiones/pr/propuesta?id=${id}`,
  ])
    assert.equal(
      (await get(ruta, { headers: { authorization: "Bearer room-secret" } }))
        .status,
      403,
    );
  for (const [ruta, cuerpo] of [
    ["/agentes/sesiones/revertir", { id, n: 1 }],
    ["/agentes/sesiones/pr", { id }],
    ["/agentes/sesiones/pr/redactar", { id }],
  ])
    assert.equal(
      (
        await post(ruta, cuerpo, {
          ...headers,
          authorization: "Bearer room-secret",
        })
      ).status,
      403,
    );

  assert.equal(
    (await post("/agentes/sesiones/revertir", { id, n: 0 })).status,
    400,
  );
  assert.equal(
    (await post("/agentes/sesiones/revertir", { id, n: 1, de_mas: 1 })).status,
    400,
  );
  assert.equal(
    (await post("/agentes/sesiones/pr", { id, titulo: "" })).status,
    400,
  );
  const revertir = await post("/agentes/sesiones/revertir", { id, n: 1 });
  assert.equal(revertir.status, 409);
  assert.equal(
    (await revertir.json()).error,
    "Detén el turno antes de revertir",
  );
  // A message the launcher did not mark as safe never reaches the browser.
  const redactar = await post("/agentes/sesiones/pr/redactar", { id });
  assert.equal(redactar.status, 502);
  assert.doesNotMatch(JSON.stringify(await redactar.json()), /secreta/);
  const pr = await post("/agentes/sesiones/pr", {
    id,
    titulo: "feat: x",
    descripcion: "d",
    borrador: true,
  });
  assert.equal(pr.status, 200);
  assert.deepEqual(JSON.parse(recibidas.at(-1).body), {
    titulo: "feat: x",
    descripcion: "d",
    borrador: true,
  });
});
