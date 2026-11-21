import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createLauncherServer } from "../index.mjs";

const fingerprint = (/** @type {string} */ s) =>
  createHash("sha256").update(s).digest("hex");

/** @param {import("node:test").TestContext} t */
async function serve(t, options = {}) {
  const links = [];
  const server = createLauncherServer({
    controlHash: fingerprint("control"),
    proyectos: { demo: "/tmp/demo" },
    espacios: {
      read: () => ({
        revision: 0,
        links: {},
        repositories: ["demo"],
        repositoryPaths: {},
      }),
      link: async (data) => (
        links.push(data),
        { revision: 1, links: {}, repositories: [], repositoryPaths: {} }
      ),
    },
    registrar: () => {},
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  /**
   * @param {string} path
   * @param {{ body?: unknown, token?: string, raw?: string }} [init]
   */
  const call = (path, { body, token = "control", raw } = {}) =>
    fetch(url + path, {
      method: body === undefined && raw === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(raw !== undefined
        ? { body: raw }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    });
  return { call, links };
}

test("only the control credential opens the launcher", async (t) => {
  const { call } = await serve(t);
  assert.equal((await call("/projects", { token: "otra" })).status, 401);
  const projects = await call("/projects");
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), ["demo"]);
  assert.deepEqual(await (await call("/status")).json(), { ok: true });
});

test("the session-era routes are gone", async (t) => {
  const { call } = await serve(t);
  for (const [path, body] of [
    ["/sesiones", { motor: "codex", brief: "b" }],
    ["/equipo/estado", {}],
    ["/eventos", {}],
  ])
    assert.equal((await call(path, { body })).status, 404, path);
  assert.equal(
    (await call("/sesiones/00000000-0000-4000-8000-000000000000/stream"))
      .status,
    404,
  );
});

test("workspace links go through and bodies are bounded", async (t) => {
  const { call, links } = await serve(t);
  const canonical = await (await call("/workspaces")).json();
  assert.deepEqual(canonical.repositories, ["demo"]);
  assert.deepEqual(canonical.links, {});
  const linked = await call("/workspaces", {
    body: { id: "p1", repository: "demo", revision: 0 },
  });
  assert.equal(linked.status, 200);
  assert.deepEqual(links, [{ id: "p1", repository: "demo", revision: 0 }]);
  assert.equal((await call("/workspaces", { raw: "{" })).status, 400);
  assert.equal((await call("/workspaces", { raw: "[]" })).status, 400);
  assert.equal(
    (await call("/workspaces", { body: { x: "a".repeat(600_000) } })).status,
    413,
  );
});

test("an unexpected failure answers 500 without echoing the request", async (t) => {
  const lines = [];
  const { call } = await serve(t, {
    espacios: {
      read: () => ({
        revision: 0,
        links: {},
        repositories: [],
        repositoryPaths: {},
      }),
      link: async () => {
        throw new Error("fallo con secreto-123");
      },
    },
    registrar: (line) => lines.push(line),
  });
  const response = await call("/workspaces", {
    body: { id: "secreto-123", repository: null, revision: 0 },
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secreto/);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /secreto-123/);
});

test("the Spanish launcher routes are retired", async (t) => {
  const { call } = await serve(t);
  for (const path of ["/estado", "/proyectos", "/espacios", "/uso"])
    assert.equal((await call(path)).status, 404, path);
});
