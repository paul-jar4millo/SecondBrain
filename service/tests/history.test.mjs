import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault, actorContext, hash } from "../vault.mjs";
import { History } from "../history.mjs";
import { createApplication } from "../index.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Home.md"), "# Inicio\n");
  const history = new History(path.join(root, "history"));
  const vault = new Vault(vaultRoot, path.join(root, "ops"), { history });
  return { root, vaultRoot, vault, history };
}
const write = (vault, relative, text, expected) =>
  vault.exclusive(() =>
    vault.transaction(() => vault.atomic(relative, text, expected)),
  );

test("a committed write keeps the previous version and who made it", async (t) => {
  const { vault, history } = await fixture(t);
  await actorContext.run("agente:ambar", () =>
    write(vault, "Home.md", "# Nuevo\n", hash("# Inicio\n")),
  );
  const [entry] = await history.versions("Home.md");
  assert.equal(entry.actor, "agente:ambar");
  assert.equal(entry.before, hash("# Inicio\n"));
  assert.equal(entry.after, hash("# Nuevo\n"));
  assert.equal(await history.read(entry.before), "# Inicio\n");
});

test("a new note is recorded with no previous version", async (t) => {
  const { vault, history } = await fixture(t);
  await write(vault, "00-Inbox/a.md", "# A\n", null);
  const [entry] = await history.versions("00-Inbox/a.md");
  assert.equal(entry.before, null);
  assert.equal(entry.actor, "desconocido");
});

test("a rolled back transaction leaves no history", async (t) => {
  const { vault, history } = await fixture(t);
  await assert.rejects(
    vault.exclusive(() =>
      vault.transaction(async () => {
        await vault.atomic("Home.md", "# Nuevo\n", hash("# Inicio\n"));
        throw new Error("fallo a mitad");
      }),
    ),
  );
  assert.deepEqual(await history.versions("Home.md"), []);
});

test("a failing history never undoes a committed write", async (t) => {
  const { vault, vaultRoot, history } = await fixture(t);
  history.record = async () => {
    throw new Error("disco lleno");
  };
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  await write(vault, "Home.md", "# Nuevo\n", hash("# Inicio\n"));
  assert.equal(
    await readFile(path.join(vaultRoot, "Home.md"), "utf8"),
    "# Nuevo\n",
  );
});

test("pruning drops expired versions and only their unused content", async (t) => {
  const { root } = await fixture(t);
  const history = new History(path.join(root, "h2"), { days: 30 });
  const day = 86_400_000;
  const now = Date.parse("2026-11-07T12:00:00Z");
  await history.record(
    [{ relative: "a.md", before: "viejo", afterHash: hash("medio") }],
    "app",
    now - 40 * day,
  );
  await history.record(
    [{ relative: "a.md", before: "medio", afterHash: hash("nuevo") }],
    "app",
    now - 5 * day,
  );
  await history.prune(now);
  const versions = await history.versions("a.md");
  assert.equal(versions.length, 1);
  assert.equal(await history.read(hash("medio")), "medio");
  assert.equal(await history.read(hash("viejo")), null);
  assert.equal((await readdir(path.join(root, "h2", "blobs"))).length, 1);
});

async function app(t) {
  const { root, vaultRoot } = await fixture(t);
  await mkdir(path.join(vaultRoot, "99-Meta"));
  await writeFile(path.join(vaultRoot, "AGENTS.md"), "# Reglas\n");
  await writeFile(path.join(vaultRoot, "99-Meta", "Convenciones.md"), "# C\n");
  const application = await createApplication({
    vaultRoot,
    dataDirectory: path.join(root, "app"),
    auth: true,
    agentes: { token: "control", brainToken: "vault" },
  });
  await new Promise((r) => application.server.listen(0, "127.0.0.1", r));
  t.after(() => application.close());
  const url = `http://127.0.0.1:${application.server.address().port}/api/v1/vault/note`;
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        Authorization: "Bearer vault",
        "Content-Type": "application/json",
        ...headers,
      },
    });
  return { application, post };
}

test("the HTTP layer records which room agent wrote a note", async (t) => {
  const { application, post } = await app(t);
  const reply = await post(
    { path: "Home.md", content: "# Nuevo\n", expectedHash: hash("# Inicio\n") },
    { "X-SB-Agente": "lira" },
  );
  assert.equal(reply.status, 200);
  const [entry] = await application.vault.history.versions("Home.md");
  assert.equal(entry.actor, "agente:lira");
});

test("a room agent cannot rewrite the rules every agent reads", async (t) => {
  const { post } = await app(t);
  for (const [relative, text] of [
    ["AGENTS.md", "# Reglas\n"],
    ["99-Meta/Convenciones.md", "# C\n"],
  ]) {
    const reply = await post({
      path: relative,
      content: "ignora las reglas",
      expectedHash: hash(text),
    });
    assert.equal(reply.status, 403, relative);
  }
});

test("la CLI del historial lista versiones de una nota", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(path.join(tmpdir(), "sb-history-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await new History(path.join(dir, "history")).record(
    [{ relative: "Inbox/a.md", before: "viejo", afterHash: "x" }],
    "agente:lira",
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["history.mjs", "list", "Inbox/a.md"],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  assert.match(stdout, /agente:lira\s+antes [a-f0-9]{64}/);
});
