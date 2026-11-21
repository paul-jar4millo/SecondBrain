import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openWorkspaces } from "../workspaces.mjs";

test("vincula proyectos sin confundir su identidad con el repositorio y detecta conflictos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-spaces-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".git"));
  const options = {
    archivo: path.join(dir, "espacios.json"),
    proyectos: { repo: dir },
    workspaces: path.join(dir, "workspaces"),
  };
  await writeFile(
    options.archivo,
    JSON.stringify({ revision: 2, vinculos: { existing: "repo" } }),
  );
  const spaces = await openWorkspaces(options);
  assert.equal(spaces.read().links.existing, "repo");
  const free = await spaces.resolve("p1");
  assert.equal(free.repository, null);
  assert.ok(free.cwd.startsWith(options.workspaces + path.sep));
  const initial = spaces.read();
  assert.deepEqual(initial.repositoryPaths, { repo: dir });
  await spaces.link({
    id: "p1",
    repository: "repo",
    revision: initial.revision,
  });
  assert.equal((await spaces.resolve("p1")).cwd, dir);
  await assert.rejects(
    spaces.link({
      id: "p2",
      repository: "repo",
      revision: initial.revision,
    }),
    /Conflicto/,
  );
  await assert.rejects(
    spaces.link({
      id: "p2",
      repository: "../vault",
      revision: spaces.read().revision,
    }),
  );
  await assert.rejects(spaces.resolve("../vault"));
  const stored = JSON.parse(await readFile(options.archivo, "utf8"));
  // The first write after a pre-v0.6 file keeps only the English key.
  assert.deepEqual(stored, {
    revision: 3,
    links: { existing: "repo", p1: "repo" },
  });
  const reopened = await openWorkspaces(options);
  assert.equal((await reopened.resolve("p1")).repository, "repo");
  await reopened.link({
    id: "p1",
    repository: null,
    revision: reopened.read().revision,
  });
  assert.equal((await reopened.resolve("p1")).repository, null);
  assert.deepEqual(JSON.parse(await readFile(options.archivo, "utf8")), {
    revision: 4,
    links: { existing: "repo", p1: null },
  });
});
