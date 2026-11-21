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

test("the feed hands over parsed events, resumes from a cursor and reports a lost log", async (t) => {
  /** @type {string[]} */
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(String(req.url));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (urls.length === 1)
      res.write(
        'id: 8\ndata: {"type":"event","event":{"type":"thread.updated","globalSeq":8}}\n\n',
      );
    else res.end('data: {"type":"snapshot-required","reason":"perdido"}\n\n');
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
  /** @type {unknown[]} */
  const events = [];
  let resets = 0;
  const stop = client.subscribe((event) => event && events.push(event), {
    after: async () => 7,
    onReset: () => resets++,
  });
  t.after(stop);
  const until = Date.now() + 3000;
  while (!events.length && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [{ type: "thread.updated", globalSeq: 8 }]);
  assert.deepEqual(urls, ["/threads/stream?after=7"]);
  // The second connection is answered with snapshot-required.
  server.closeAllConnections();
  const later = Date.now() + 8000;
  while (!resets && Date.now() < later)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resets, 1);
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
  const projects = await fetch(base + "/agents/projects");
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), ["demo"]);
  for (const route of [
    "/agents/workspaces",
    "/agents/projects",
    "/agents/models",
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
    "/agentes/espacios",
    "/agentes/proyectos-lanzador",
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
});
