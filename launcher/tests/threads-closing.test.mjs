import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGit } from "../git.mjs";
import { openThreads } from "../threads/runtime.mjs";
import { commitTitle } from "../threads/engine/closing.ts";
import { git as gitSync, repoSintetico } from "./helpers-git.mjs";

const AGENT = { engine: "codex" };

/**
 * @param {any} t
 * @param {(ctx: any) => Promise<void> | void} script
 */
async function setup(t, script) {
  const repo = await repoSintetico(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), "sb-threads-close-"));
  /** @type {string[][]} */
  const ghCalls = [];
  const factory = () => {
    let alive = true;
    return {
      isAlive: () => alive,
      interrupt() {},
      async shutdown() {
        alive = false;
      },
      async runTurn(/** @type {any} */ ctx) {
        ctx.onAbort(() => {});
        await script(ctx);
        return { status: "completed" };
      },
    };
  };
  const threads = openThreads({
    env: {},
    dataDir,
    projects: { demo: repo },
    git: createGit({ env: process.env }).git,
    gh: async (_cwd, args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "view") throw new Error("no pr");
      return { stdout: "https://github.com/x/y/pull/7\n", stderr: "" };
    },
    maxActive: 2,
    controllers: { codex: factory },
    context: {
      async buildAgentContext({ threadId, cwd }) {
        return { session: { id: threadId }, cwd };
      },
      async runSetup() {
        return 0;
      },
    },
  });
  t.after(async () => {
    await threads.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const engine = threads.engine;
  const create = async (prompt = "Cambia a") => {
    const thread = await engine.create({
      kind: "repo",
      repoPath: "demo",
      prompt,
      agent: AGENT,
    });
    for (let i = 0; i < 400 && threads.store.turns(thread.id).length < 1; i++)
      await new Promise((r) => setTimeout(r, 10));
    await engine.idle(thread.id);
    return engine.snapshot(thread.id).thread;
  };
  return { repo, threads, engine, store: threads.store, ghCalls, create };
}

const edit = (file, text) => async (/** @type {any} */ ctx) =>
  writeFile(path.join(ctx.cwd, file), text);

test("commit titles follow Conventional Commits", () => {
  assert.equal(
    commitTitle(undefined, "Arregla el login"),
    "feat: Arregla el login",
  );
  assert.equal(commitTitle("fix(api): x", "y"), "fix(api): x");
});

test("merge integrates the branch into the checked-out base and cleans up", async (t) => {
  const env = await setup(t, edit("a.txt", "nuevo\n"));
  const thread = await env.create();
  const closed = await env.engine.close(thread.id, { mode: "merge" });
  assert.equal(closed.status, "done");
  assert.equal(closed.closeMode, "merge");
  assert.equal(await readFile(path.join(env.repo, "a.txt"), "utf8"), "nuevo\n");
  assert.equal(gitSync(env.repo, "status", "--porcelain"), "");
  assert.match(
    gitSync(env.repo, "log", "-1", "--format=%s"),
    /^feat: Cambia a$/,
  );
  assert.equal(existsSync(thread.repo.worktree), false);
  assert.equal(gitSync(env.repo, "branch", "--list", thread.repo.branch), "");
  await assert.rejects(
    env.engine.send(thread.id, { text: "más", mode: "send" }),
    /cerrado/,
  );
});

test("a conflicting merge changes nothing and reports the files", async (t) => {
  const env = await setup(t, edit("a.txt", "del thread\n"));
  const thread = await env.create();
  await writeFile(path.join(env.repo, "a.txt"), "de main\n");
  gitSync(env.repo, "commit", "-qam", "fix: main");
  const head = gitSync(env.repo, "rev-parse", "HEAD");
  await assert.rejects(
    env.engine.close(thread.id, { mode: "merge" }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, "conflict");
      assert.deepEqual(error.details.conflicts, ["a.txt"]);
      return true;
    },
  );
  assert.equal(gitSync(env.repo, "rev-parse", "HEAD"), head);
  assert.equal(gitSync(env.repo, "status", "--porcelain"), "");
  assert.equal(
    await readFile(path.join(env.repo, "a.txt"), "utf8"),
    "de main\n",
  );
  assert.ok(existsSync(thread.repo.worktree));
  assert.equal(env.store.getThread(thread.id).status, "idle");
  assert.ok(env.store.items(thread.id).some((i) => i.code === "close-failed"));
});

test("local edits in the base checkout block the merge without changes", async (t) => {
  const env = await setup(t, edit("a.txt", "nuevo\n"));
  const thread = await env.create();
  await writeFile(path.join(env.repo, "a.txt"), "a medias\n");
  const head = gitSync(env.repo, "rev-parse", "HEAD");
  await assert.rejects(
    env.engine.close(thread.id, { mode: "merge" }),
    /cambios locales/,
  );
  assert.equal(gitSync(env.repo, "rev-parse", "HEAD"), head);
  assert.equal(
    await readFile(path.join(env.repo, "a.txt"), "utf8"),
    "a medias\n",
  );
});

test("merge updates a base branch that is not checked out", async (t) => {
  const env = await setup(t, edit("b.txt", "otro\n"));
  const thread = await env.create();
  gitSync(env.repo, "checkout", "-q", "-b", "otra");
  await env.engine.close(thread.id, { mode: "merge" });
  assert.equal(gitSync(env.repo, "show", "main:b.txt"), "otro");
  assert.equal(gitSync(env.repo, "rev-parse", "--abbrev-ref", "HEAD"), "otra");
});

test("discard drops the worktree and the branch", async (t) => {
  const env = await setup(t, edit("a.txt", "x\n"));
  const thread = await env.create();
  const closed = await env.engine.close(thread.id, { mode: "discard" });
  assert.equal(closed.closeMode, "discard");
  assert.equal(existsSync(thread.repo.worktree), false);
  assert.equal(gitSync(env.repo, "branch", "--list", thread.repo.branch), "");
  assert.equal(await readFile(path.join(env.repo, "a.txt"), "utf8"), "uno\n");
});

test("pr pushes the branch and opens the pull request", async (t) => {
  const env = await setup(t, edit("a.txt", "pr\n"));
  const remote = await mkdtemp(path.join(tmpdir(), "sb-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  gitSync(remote, "init", "-q", "--bare");
  gitSync(env.repo, "remote", "add", "origin", remote);
  const thread = await env.create();
  const closed = await env.engine.close(thread.id, {
    mode: "pr",
    title: "fix: corrige a",
    body: "cuerpo",
  });
  assert.equal(closed.prUrl, "https://github.com/x/y/pull/7");
  assert.equal(
    gitSync(remote, "log", "-1", "--format=%s", thread.repo.branch),
    "fix: corrige a",
  );
  const create = env.ghCalls.find((a) => a[1] === "create");
  assert.deepEqual(create.slice(2), [
    "--head",
    thread.repo.branch,
    "--base",
    "main",
    "--title",
    "fix: corrige a",
    "--body",
    "cuerpo",
  ]);
  // The worktree stays until the thread is archived; a PR branch stays.
  assert.ok(existsSync(thread.repo.worktree));
  const archived = await env.engine.archive(thread.id);
  assert.equal(archived.status, "archived");
  assert.equal(existsSync(thread.repo.worktree), false);
  assert.equal(
    gitSync(env.repo, "branch", "--list", thread.repo.branch).replace(
      /^[*+ ]+/,
      "",
    ),
    thread.repo.branch,
  );
});

test("closing needs a finished turn and a repo for pr or merge", async (t) => {
  const env = await setup(t, async () => {});
  const scratch = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await env.engine.idle(scratch.id);
  await assert.rejects(
    env.engine.close(scratch.id, { mode: "pr" }),
    /repositorio/,
  );
  await assert.rejects(env.engine.close(scratch.id, { mode: "nope" }));
  const thread = await env.create();
  await assert.rejects(
    env.engine.close(thread.id, { mode: "merge" }),
    /No hay cambios/,
  );
  assert.equal(env.store.getThread(thread.id).status, "idle");
  const closed = await env.engine.close(scratch.id, { mode: "discard" });
  assert.equal(existsSync(scratch.workspace), false);
  assert.equal(closed.status, "done");
  await assert.rejects(
    env.engine.close(scratch.id, { mode: "discard" }),
    /ya está cerrado/,
  );
});

test("archiving without a PR removes the worktree and the branch", async (t) => {
  const env = await setup(t, edit("a.txt", "x\n"));
  const thread = await env.create();
  const archived = await env.engine.archive(thread.id);
  assert.equal(archived.status, "archived");
  assert.equal(existsSync(thread.repo.worktree), false);
  assert.equal(gitSync(env.repo, "branch", "--list", thread.repo.branch), "");
  assert.equal((await env.engine.archive(thread.id)).status, "archived");
});
