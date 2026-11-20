import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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
  const spaces = await openWorkspaces(options);
  const free = await spaces.resolver("p1");
  assert.equal(free.repositorio, null);
  assert.ok(free.cwd.startsWith(options.workspaces + path.sep));
  const initial = spaces.leer();
  assert.deepEqual(initial.repositoryPaths, { repo: dir });
  await spaces.vincular({
    id: "p1",
    repositorio: "repo",
    revision: initial.revision,
  });
  assert.equal((await spaces.resolver("p1")).cwd, dir);
  await assert.rejects(
    spaces.vincular({
      id: "p2",
      repositorio: "repo",
      revision: initial.revision,
    }),
    /Conflicto/,
  );
  await assert.rejects(
    spaces.vincular({
      id: "p2",
      repositorio: "../vault",
      revision: spaces.leer().revision,
    }),
  );
  await assert.rejects(spaces.resolver("../vault"));
  const reopened = await openWorkspaces(options);
  assert.equal((await reopened.resolver("p1")).repositorio, "repo");
  await reopened.vincular({
    id: "p1",
    repositorio: null,
    revision: reopened.leer().revision,
  });
  assert.equal((await reopened.resolver("p1")).repositorio, null);
});
