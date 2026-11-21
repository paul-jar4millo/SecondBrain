// Safety net for refactoring the HTTP layer: every route declared in
// routes.mjs must reach its handler. A handler may still answer 4xx (missing
// body, unknown entity, no agent session); what fails is a reply produced
// before dispatch: "route not found", a CSRF rejection or an invalid query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";
import { ROUTES } from "../routes.mjs";
import { legacyPaths } from "../http/legacy-paths.mjs";

const PRE_DISPATCH = [
  "Ruta de API no encontrada.",
  "Consulta inválida.",
  '"code":"csrf"',
];

/** Smallest query string the route's schema accepts: required fields only. */
const validQuery = (schema) => {
  if (schema.safeParse({}).success) return "";
  const query = {};
  for (const [key, field] of Object.entries(schema.shape ?? {})) {
    if (field.safeParse(undefined).success) continue;
    const sample = [
      randomUUID(),
      "1",
      "x",
      "thr_sample01",
      "req_sample01",
    ].find((value) => field.safeParse(value).success);
    if (sample === undefined) throw new Error(`No sample for query "${key}"`);
    query[key] = sample;
  }
  assert.ok(schema.safeParse(query).success, "sample query must be valid");
  return "?" + new URLSearchParams(query);
};

test("every declared route reaches its handler", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-routes-"));
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Inicio\n");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: path.join(root, ".data"),
    auth: false,
    serveDashboard: false,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const blocked = [];
  try {
    const csrf = await fetch(base + "/auth/csrf");
    const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]);
    const { token } = await csrf.json();
    const headers = {
      "content-type": "application/json",
      cookie: cookie.join("; "),
      "x-csrf-token": token,
    };
    for (const [key, policy] of ROUTES) {
      const [method, route] = key.split(" ");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(base + route + validQuery(policy.query), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : "{}",
          signal: controller.signal,
        });
        // Streams answer with headers and stay open; that is enough.
        if (response.headers.get("content-type")?.includes("event-stream")) {
          controller.abort();
          continue;
        }
        const text = await response.text();
        if (PRE_DISPATCH.some((marker) => text.includes(marker)))
          blocked.push(`${key} → ${response.status} ${text.slice(0, 80)}`);
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await app.close?.();
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(blocked, [], "routes that never reached a handler");
});

test("every old HTTP path still points to a route with a canonical policy", () => {
  const canonical = new Set(
    Array.from(ROUTES.keys(), (key) => key.split(" ")[1]),
  );
  for (const [alias, target] of legacyPaths) {
    assert.ok(canonical.has(target), target);
    assert.ok(!canonical.has(alias), alias);
  }
});

test("service aliases can be retired while the canonical API stays available", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-routes-retired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "00-Inbox"));
  await writeFile(path.join(root, "Home.md"), "# Synthetic test\n");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: path.join(root, ".data"),
    auth: false,
    legacyHttpRoutes: false,
  });
  t.after(() => app.close());
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" +
    /** @type {import("node:net").AddressInfo} */ (app.server.address()).port +
    "/api/v1";
  const old = await fetch(base + "/aprobaciones");
  assert.equal(old.status, 404);
  assert.equal(old.headers.get("deprecation"), null);
  const current = await fetch(base + "/approvals");
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), []);
});
