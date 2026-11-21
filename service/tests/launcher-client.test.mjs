import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createLauncherClient } from "../launcher-client.mjs";
import { createApplication } from "../index.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

class Failure extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

test("forwards catalog calls to the authenticated launcher without exposing the token", async (t) => {
  /** @type {{ url?: string, auth?: string, body: string }[]} */
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
    res.end(req.url === "/projects" ? '["demo"]' : "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const client = createLauncherClient(Failure, {
    url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    token: "secreto",
  });
  assert.deepEqual(await client.proyectos(), ["demo"]);
  await client.modelos();
  await client.espacios();
  await client.espacios({ id: "p1", repositorio: null, revision: 0 });
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/projects", "/models", "/workspaces", "/workspaces"],
  );
  assert.ok(requests.every((r) => r.auth === "Bearer secreto"));
  assert.ok(requests.every((r) => !r.body.includes("secreto")));
});

test("change notifications follow the launcher's thread feed", async (t) => {
  /** @type {string[]} */
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(String(req.url));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('id: 1\ndata: {"type":"thread.created"}\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = createLauncherClient(Failure, {
    url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    token: "secreto",
  });
  let calls = 0;
  const stop = client.subscribe(() => calls++);
  t.after(stop);
  const until = Date.now() + 3000;
  while (calls < 2 && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls >= 2, "reconcile on connect, then one per event");
  assert.deepEqual(urls, ["/threads/stream"]);
});

test("catalog routes deny the room credential and the session routes are gone", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = http.createServer((req, res) => {
    if (req.url === "/threads/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/projects" ? '["demo"]' : "{}");
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
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (runner.address()).port}`,
      token: "control",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}/api/v1`;
  const canonical = await fetch(base + "/agents/projects");
  assert.equal(canonical.status, 200);
  assert.equal(canonical.headers.get("Deprecation"), null);
  assert.deepEqual(await canonical.json(), ["demo"]);
  const projects = await fetch(base + "/agentes/proyectos-lanzador");
  assert.match(projects.headers.get("Deprecation") ?? "", /^@[0-9]+$/);
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), ["demo"]);
  for (const route of [
    "/agents/workspaces",
    "/agents/projects",
    "/agents/models",
    "/agentes/espacios",
    "/agentes/proyectos-lanzador",
    "/agentes/modelos-lanzador",
  ])
    assert.equal(
      (
        await fetch(base + route, {
          headers: { authorization: "Bearer room-secret" },
        })
      ).status,
      403,
      route,
    );
  for (const route of [
    "/agentes/sesiones",
    "/agentes/terminal/stream?id=f1111111-1111-4111-8111-111111111111",
    "/agentes/sesiones/diff?id=f1111111-1111-4111-8111-111111111111",
    "/encargos",
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
});

test("a new service can write workspace links through an older launcher", async (t) => {
  /** @type {{ path: string, body: Record<string, unknown> }[]} */
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      path: req.url ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/workspaces") {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Ruta no encontrada." }));
    }
    res.end(
      JSON.stringify({
        revision: 2,
        vinculos: { p1: "demo" },
        repositorios: ["demo"],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const client = createLauncherClient(Failure, {
    url:
      "http://127.0.0.1:" +
      /** @type {import("node:net").AddressInfo} */ (server.address()).port,
    token: "synthetic",
  });
  assert.deepEqual(
    await client.espacios({ id: "p1", repository: "demo", revision: 1 }),
    {
      revision: 2,
      links: { p1: "demo" },
      repositories: ["demo"],
    },
  );
  assert.deepEqual(calls, [
    {
      path: "/workspaces",
      body: { id: "p1", repository: "demo", revision: 1 },
    },
    { path: "/espacios", body: { id: "p1", repositorio: "demo", revision: 1 } },
  ]);
});
