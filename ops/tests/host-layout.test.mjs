import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hostUnitName,
  hostUnitText,
  remapHostPath,
} from "../migration/host-layout.mjs";
import {
  migrateHostLayout,
  rewriteThreadPaths,
} from "../migration/migrate-host-layout.mjs";

const oldState = "/var/lib/sb-agente/estado/lanzador";
const newState = "/var/lib/sb-agent/state/launcher";
const oldProjects = "/srv/sb-agente/proyectos";
const newProjects = "/srv/sb-agent/projects";

test("renames managed unit references while keeping the Unix account and home", () => {
  assert.equal(
    hostUnitName("secondbrain-lanzador.service"),
    "secondbrain-launcher.service",
  );
  assert.equal(
    hostUnitName("secondbrain-aviso@.service"),
    "secondbrain-notify@.service",
  );
  assert.equal(hostUnitName("secondbrain.service"), "secondbrain.service");
  assert.equal(
    hostUnitText(
      "OnFailure=secondbrain-aviso@%n.service\nEnvironment=SB_LANZADOR_DATA_DIR=" +
        oldState +
        "\nUser=sb-agente\nReadWritePaths=/srv/sb-agente /var/lib/sb-agente\n",
    ),
    "OnFailure=secondbrain-notify@%n.service\nEnvironment=SB_LAUNCHER_DATA_DIR=" +
      newState +
      "\nUser=sb-agente\nReadWritePaths=/srv/sb-agent /var/lib/sb-agente /var/lib/sb-agent\n",
  );
  assert.equal(
    remapHostPath(oldProjects + "/sandbox"),
    newProjects + "/sandbox",
  );
  assert.equal(
    remapHostPath(oldProjects + "-unrelated"),
    oldProjects + "-unrelated",
  );
  assert.equal(
    remapHostPath(newState + "/threads.sqlite", true),
    oldState + "/threads.sqlite",
  );
});

test("updates SQLite thread locations in the projection and replay events without rewriting messages", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE events(thread_id TEXT,seq INTEGER,type TEXT,data TEXT)",
    );
    const thread = {
      repo: {
        path: oldProjects + "/sandbox",
        worktree: oldState + "/threads/worktrees/t1",
      },
      title: oldProjects,
      workspace: null,
    };
    const event = { type: "thread.created", thread };
    const patched = {
      type: "thread.updated",
      patch: { workspace: oldState + "/threads/scratch/t2" },
    };
    const item = { type: "item.completed", item: { text: oldState } };
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(
      "t1",
      JSON.stringify(thread),
    );
    for (const [i, value] of [event, patched, item].entries())
      db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)").run(
        "t1",
        i,
        value.type,
        JSON.stringify(value),
      );
    rewriteThreadPaths(db);
    const row = JSON.parse(db.prepare("SELECT data FROM threads").get().data);
    assert.deepEqual(row.repo, {
      path: newProjects + "/sandbox",
      worktree: newState + "/threads/worktrees/t1",
    });
    assert.equal(row.title, oldProjects);
    const read = () =>
      db
        .prepare("SELECT data FROM events ORDER BY seq")
        .all()
        .map(({ data }) => JSON.parse(data));
    assert.deepEqual(read(), [
      { ...event, thread: row },
      { ...patched, patch: { workspace: newState + "/threads/scratch/t2" } },
      item,
    ]);
    rewriteThreadPaths(db, true);
    assert.deepEqual(read(), [event, patched, item]);
  } finally {
    db.close();
  }
});

test("plans without mutations, preserves alias access and rolls the host layout back", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-host-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(name, bytes) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await put(oldProjects + "/sandbox/README.md", "kept");
  await put(oldState + "/state", "kept");
  await put(
    "/etc/systemd/system/secondbrain-lanzador.service",
    "Environment=SB_LANZADOR_DATA_DIR=" + oldState + "\nUser=sb-agente\n",
  );
  await put(
    "/etc/sb-agente/proyectos.json",
    JSON.stringify({ sandbox: oldProjects + "/sandbox" }),
  );
  const calls = [];
  const host = {
    state(unit) {
      return {
        active: unit === "secondbrain-lanzador.service",
        enabled: unit === "secondbrain-lanzador.service",
      };
    },
    run(...args) {
      calls.push(args);
    },
    waitForLauncher() {
      calls.push(["wait"]);
    },
    repairWorktrees() {},
  };
  await migrateHostLayout({ root, host });
  assert.equal(calls.length, 0);
  await assert.rejects(lstat(path.join(root, newProjects)), {
    code: "ENOENT",
  });
  await migrateHostLayout({ root, host, mode: "apply" });
  assert.equal(
    await readFile(path.join(root, newProjects, "sandbox/README.md"), "utf8"),
    "kept",
  );
  assert.equal(
    await readFile(path.join(root, oldProjects, "sandbox/README.md"), "utf8"),
    "kept",
  );
  assert.match(
    await readFile(
      path.join(root, "/etc/systemd/system/secondbrain-launcher.service"),
      "utf8",
    ),
    /SB_LAUNCHER_DATA_DIR=/,
  );
  assert.ok(
    calls.some(
      ([command, unit]) =>
        command === "start" && unit === "secondbrain-launcher.service",
    ),
  );
  const before = calls.length;
  await migrateHostLayout({ root, host, mode: "apply" });
  assert.equal(calls.length, before);
  await migrateHostLayout({ root, host, mode: "rollback" });
  assert.equal(
    await readFile(path.join(root, oldProjects, "sandbox/README.md"), "utf8"),
    "kept",
  );
  assert.equal((await lstat(path.join(root, oldState))).isDirectory(), true);
  assert.match(
    await readFile(
      path.join(root, "/etc/systemd/system/secondbrain-lanzador.service"),
      "utf8",
    ),
    /SB_LANZADOR_DATA_DIR=/,
  );
});

test("refuses conflicting managed data before stopping any service", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-host-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, oldProjects), { recursive: true });
  await mkdir(path.join(root, newProjects), { recursive: true });
  await writeFile(path.join(root, oldProjects, "marker"), "old");
  await writeFile(path.join(root, newProjects, "marker"), "new");
  const host = {
    state: () => ({ active: true, enabled: true }),
    run: () =>
      assert.fail(
        "A conflicting target must be found before stopping a service",
      ),
  };
  await assert.rejects(
    migrateHostLayout({ root, host, mode: "apply" }),
    /Both managed paths exist/,
  );
  assert.equal(
    await readFile(path.join(root, oldProjects, "marker"), "utf8"),
    "old",
  );
  assert.equal(
    await readFile(path.join(root, newProjects, "marker"), "utf8"),
    "new",
  );
});
