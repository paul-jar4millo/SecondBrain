import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Vault } from "../vault.mjs";
import { createApplication } from "../index.mjs";
import { createLanzador } from "../lanzador.mjs";
import { Failure } from "../vault.mjs";
import http from "node:http";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-scale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "00-Inbox"));
  await writeFile(path.join(root, "Home.md"), "# Home\n");
  await writeFile(
    path.join(root, "00-Inbox/privada.md"),
    "# Privada\n\nContenido privado\n",
  );
  return root;
}
test("unchanged scans reuse file contents while external edits, rename and deletion remain visible", async (t) => {
  const root = await fixture(t),
    vault = new Vault(root);
  await vault.read();
  assert.equal(vault.metrics?.fileReads, 2);
  await vault.read();
  assert.equal(vault.metrics.fileReads, 2);
  await writeFile(path.join(root, "00-Inbox/privada.md"), "# Cambiada\n");
  assert.ok((await vault.read()).items.some((i) => i.title === "Cambiada"));
  assert.equal(vault.metrics.fileReads, 3);
  await rename(
    path.join(root, "00-Inbox/privada.md"),
    path.join(root, "00-Inbox/nueva.md"),
  );
  assert.ok((await vault.read()).byPath.has("00-Inbox/nueva.md"));
  await rm(path.join(root, "00-Inbox/nueva.md"));
  assert.equal((await vault.read()).byPath.size, 1);
});
test("launcher events reconnect with the control credential and unsubscribe on stop", async (t) => {
  let abiertas = 0,
    autorizadas = 0,
    respuestas = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer control") {
      res.writeHead(401).end();
      return;
    }
    autorizadas++;
    abiertas++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: changed\n\n");
    respuestas.push(res);
    res.on("close", () => abiertas--);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cambios = 0;
  const malo = createLanzador(Failure, { url, token: "otro" }).subscribe(
    () => cambios++,
  );
  await new Promise((r) => setTimeout(r, 100));
  malo();
  assert.equal(cambios, 0);
  const stop = createLanzador(Failure, { url, token: "control" }).subscribe(
    () => cambios++,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(cambios >= 1 && autorizadas === 1);
  respuestas[0].write("data: changed\n\n");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(cambios >= 2);
  stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(abiertas, 0);
});
test("imports reuse the batch snapshot and write the index once without losing native tasks", async (t) => {
  const root = await fixture(t),
    vault = new Vault(root);
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: randomUUID(),
    kind: "task",
    title: `Tarea ${i}`,
    version: 0,
    status: "pending",
  }));
  assert.equal((await vault.import(items)).imported, 100);
  const data = await vault.read();
  assert.equal(data.items.filter((i) => i.kind === "task").length, 100);
  assert.ok(
    vault.metrics.fileReads < 120,
    `read ${vault.metrics.fileReads} files`,
  );
});
test("items omit hidden note bodies, negotiate gzip and invalidate ETags after an external edit", async (t) => {
  const root = await fixture(t);
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: path.join(root, ".data"),
    auth: false,
  });
  t.after(() => app.close());
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const response = await fetch(base + "/items", {
    headers: { "Accept-Encoding": "gzip" },
  });
  const items = await response.json();
  assert.equal(items.find((i) => i.title === "Privada").body, undefined);
  assert.equal(response.headers.get("content-encoding"), "gzip");
  const tag = response.headers.get("etag");
  assert.ok(tag);
  assert.equal(
    (await fetch(base + "/items", { headers: { "If-None-Match": tag } }))
      .status,
    304,
  );
  await writeFile(path.join(root, "00-Inbox/privada.md"), "# Cambiada\n");
  const changed = await fetch(base + "/items", {
    headers: { "If-None-Match": tag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), tag);
  await rename(path.join(root, "00-Inbox"), path.join(root, "oculta"));
  await rename(path.join(root, "Home.md"), path.join(root, "Home-ausente.md"));
  assert.equal((await fetch(base + "/health")).status, 503);
});
