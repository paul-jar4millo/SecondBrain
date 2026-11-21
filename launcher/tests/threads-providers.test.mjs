// Threads driving the real provider controllers against fake Codex and ACP
// processes: one process per thread across turns, interrupts, MCP forms
// answered by the owner, and the process released on archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { createGit } from "../git.mjs";
import { openThreads } from "../threads/runtime.mjs";
import { createProviderContextFactory } from "../threads/provider-context.mjs";
import {
  FAKE_ACP_SCRIPT,
  FAKE_CODEX_SCRIPT,
  isPidAlive,
  waitFor,
} from "./helpers/provider-fakes.mjs";
import { repoSintetico } from "./helpers-git.mjs";

const TIMEOUT = 15000;

/**
 * @param {import("node:test").TestContext} t
 * @param {{ mode?: string, projects?: Record<string, string> }} [options]
 */
async function setup(t, { mode, projects = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-providers-"));
  const codexScript = path.join(dir, "codex-fake.mjs");
  const acpScript = path.join(dir, "acp-fake.mjs");
  await writeFile(codexScript, FAKE_CODEX_SCRIPT);
  await writeFile(acpScript, FAKE_ACP_SCRIPT);
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: path.join(dir, ".codex"),
    SB_CODEX_BIN: process.execPath,
    SB_LAUNCHER_DATA_DIR: path.join(dir, "data"),
  };
  /** @type {{ bin: string, args: string[] }[]} */
  const spawned = [];
  const context = createProviderContextFactory({
    env,
    tokenDir: path.join(dir, "tokens"),
    // Every CLI becomes a fake script; the Codex binary is node itself.
    spawn: /** @type {typeof nodeSpawn} */ (
      (bin, args, options) => {
        spawned.push({ bin, args: [...args] });
        const script = bin === process.execPath ? codexScript : acpScript;
        return nodeSpawn(process.execPath, [script, ...args], {
          ...options,
          env: {
            ...options?.env,
            ...(mode ? { FAKE_CODEX_MODE: mode } : {}),
          },
        });
      }
    ),
  });
  const threads = openThreads({
    env,
    dataDir: path.join(dir, "data"),
    projects,
    git: createGit({ env: process.env }).git,
    maxActive: 2,
    context,
  });
  t.after(async () => {
    await threads.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 100,
    });
  });
  const { engine, store } = threads;
  /** @param {string} id */
  const replies = (id) =>
    store
      .items(id)
      .filter((i) => i.kind === "assistant_message")
      .map((i) => String(i.text));
  return { engine, store, spawned, replies };
}

/** @param {string} text */
const pidOf = (text) => /pid=(\d+)/.exec(text)?.[1];

test(
  "a Codex thread keeps one app-server process across turns",
  { timeout: TIMEOUT },
  async (t) => {
    const env = await setup(t);
    const thread = await env.engine.create({
      kind: "scratch",
      prompt: "primero",
      agent: { engine: "codex" },
    });
    await waitFor(() => env.replies(thread.id).length === 1, TIMEOUT);
    await env.engine.idle(thread.id);
    await env.engine.send(thread.id, { text: "segundo", mode: "send" });
    await waitFor(() => env.replies(thread.id).length === 2, TIMEOUT);
    await env.engine.idle(thread.id);
    const [first, second] = env.replies(thread.id);
    assert.match(second, /turno=2/);
    assert.match(second, /prev=primero/);
    assert.equal(pidOf(first), pidOf(second));
    assert.equal(env.spawned.length, 1);
    assert.ok(env.spawned[0].args.includes("app-server"));
    assert.equal(env.store.getThread(thread.id).status, "idle");
    const pid = Number(pidOf(second));
    assert.ok(isPidAlive(pid));
    await env.engine.archive(thread.id);
    await waitFor(() => !isPidAlive(pid), TIMEOUT);
  },
);

test(
  "interrupting a Codex turn ends it and the thread stays usable",
  { timeout: TIMEOUT },
  async (t) => {
    const env = await setup(t);
    const thread = await env.engine.create({
      kind: "scratch",
      prompt: "ESPERAR_INTERRUMPIR",
      agent: { engine: "codex" },
    });
    // The fake streams its first words once the turn really started.
    await waitFor(
      () =>
        env.store.items(thread.id).some((i) => i.kind === "assistant_message"),
      TIMEOUT,
    );
    await env.engine.interrupt(thread.id);
    await env.engine.idle(thread.id);
    const [turn] = env.store.turns(thread.id);
    assert.equal(turn.outcome, "interrupted");
    await env.engine.send(thread.id, { text: "seguimos", mode: "send" });
    await waitFor(
      () => env.replies(thread.id).some((text) => /turno=2/.test(text)),
      TIMEOUT,
    );
    assert.equal(env.spawned.length, 1);
  },
);

test(
  "an MCP form from Codex waits for the owner and returns their values",
  { timeout: TIMEOUT },
  async (t) => {
    const env = await setup(t, { mode: "elicitation" });
    const thread = await env.engine.create({
      kind: "scratch",
      prompt: "configura",
      agent: { engine: "codex" },
    });
    const request = await waitFor(
      () => env.store.requests(thread.id).find((r) => r.status === "open"),
      TIMEOUT,
    );
    assert.equal(env.store.getThread(thread.id).status, "waiting-user");
    env.engine.answer(thread.id, request.id, {
      answer: {
        values: { entorno: "staging", reintentos: "3", confirmar: true },
      },
      origin: "app",
    });
    await env.engine.idle(thread.id);
    const reply = env.replies(thread.id).join("\n");
    assert.match(reply, /elicitation=/);
    assert.match(reply, /"entorno":"staging"/);
    assert.match(reply, /"reintentos":3/);
    assert.doesNotMatch(reply, /omitida/);
    assert.equal(env.store.getThread(thread.id).status, "idle");
  },
);

test(
  "an Antigravity thread runs ACP turns on one process",
  { timeout: TIMEOUT },
  async (t) => {
    const env = await setup(t);
    const thread = await env.engine.create({
      kind: "scratch",
      prompt: "hola",
      agent: { engine: "agy" },
    });
    await waitFor(() => env.replies(thread.id).length === 1, TIMEOUT);
    await env.engine.idle(thread.id);
    await env.engine.send(thread.id, { text: "otra vez", mode: "send" });
    await waitFor(() => env.replies(thread.id).length === 2, TIMEOUT);
    await env.engine.idle(thread.id);
    const [first, second] = env.replies(thread.id);
    assert.match(first, /^acp pid=/);
    assert.match(second, /turno=2/);
    assert.equal(pidOf(first), pidOf(second));
    assert.equal(env.spawned.length, 1);
  },
);

test(
  "closing a repo thread stops the agent before removing its worktree",
  { timeout: TIMEOUT },
  async (t) => {
    const repo = await repoSintetico(t);
    const env = await setup(t, { projects: { demo: repo } });
    const thread = await env.engine.create({
      kind: "repo",
      repoPath: "demo",
      prompt: "hola",
      agent: { engine: "codex" },
    });
    await waitFor(() => env.replies(thread.id).length === 1, TIMEOUT);
    await env.engine.idle(thread.id);
    const pid = Number(pidOf(env.replies(thread.id)[0]));
    assert.ok(isPidAlive(pid));
    // The agent's process lives inside the worktree; Windows refuses to
    // remove a folder that is a process's working directory.
    const closed = await env.engine.close(thread.id, { mode: "discard" });
    assert.equal(closed.status, "done");
    assert.equal(existsSync(thread.repo.worktree), false);
    await waitFor(() => !isPidAlive(pid), TIMEOUT);
  },
);
