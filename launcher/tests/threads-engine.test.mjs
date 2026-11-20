import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGit } from "../git.mjs";
import { openThreads } from "../threads/runtime.mjs";
import { repoSintetico } from "./helpers-git.mjs";

const AGENT = { engine: "codex" };

/**
 * A provider controller whose turns run `script(ctx, turnNumber)`.
 * @param {(ctx: any, n: number) => Promise<any> | any} script
 * @param {{ steer?: boolean }} [options]
 */
function fakeControllers(script, { steer = false } = {}) {
  const log = {
    turns: /** @type {any[]} */ ([]),
    steers: /** @type {string[]} */ ([]),
    created: 0,
    shutdowns: 0,
  };
  const factory = () => {
    log.created++;
    let alive = true;
    return {
      isAlive: () => alive,
      interrupt() {},
      async shutdown() {
        alive = false;
        log.shutdowns++;
      },
      async runTurn(/** @type {any} */ ctx) {
        log.turns.push({
          prompt: ctx.prompt,
          cwd: ctx.cwd,
          conversacionId: ctx.session.conversacionId,
        });
        let aborted = false;
        ctx.onAbort(() => (aborted = true));
        ctx.onControl({
          supportsSteer: steer,
          ...(steer
            ? {
                steer: async (/** @type {string} */ text) =>
                  log.steers.push(text),
              }
            : {}),
        });
        const result = await script(ctx, log.turns.length, () => aborted);
        return result ?? { status: aborted ? "interrupted" : "completed" };
      },
    };
  };
  return { controllers: { codex: factory, claude: factory }, log };
}

const fakeContext = () => {
  const setups = /** @type {string[][]} */ ([]);
  return {
    setups,
    context: {
      async buildAgentContext(/** @type {any} */ { threadId, agent, cwd }) {
        return { session: { id: threadId, motor: agent.engine }, cwd };
      },
      async runSetup(/** @type {any} */ { argv, onOutput }) {
        setups.push(argv);
        onOutput("installed\n");
        return 0;
      },
    },
  };
};

/** @param {any} t */
async function setup(t, script, options = {}) {
  const repo = await repoSintetico(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), "sb-threads-engine-"));
  const { controllers, log } = fakeControllers(script, options);
  const { context, setups } = fakeContext();
  const threads = openThreads({
    env: {},
    dataDir,
    projects: { demo: repo },
    git: createGit({ env: process.env }).git,
    maxActive: options.maxActive ?? 2,
    controllers,
    context,
  });
  t.after(async () => {
    await threads.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    repo,
    dataDir,
    threads,
    log,
    setups,
    engine: threads.engine,
    store: threads.store,
  };
}

const gate = () => {
  /** @type {() => void} */
  let open = () => {};
  const promise = new Promise((r) => (open = () => r(undefined)));
  return { promise, open };
};

const waitFor = async (/** @type {() => any} */ predicate, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("a repo thread works in its own worktree and branch, with diffs", async (t) => {
  const env = await setup(t, async (ctx) => {
    ctx.delta("m1", "Hola ");
    ctx.emit({
      type: "command",
      id: "c1",
      command: "npm test",
      status: "in-progress",
    });
    ctx.emit({
      type: "command",
      id: "c1",
      command: "npm test",
      output: "ok",
      exitCode: 0,
      status: "completed",
    });
    ctx.tool("c1", { nombre: "commandExecution", estado: "ok" });
    await writeFile(path.join(ctx.cwd, "a.txt"), "uno cambiado\n");
    ctx.nativeId("native-1");
    ctx.message("m1", "Hola mundo");
    ctx.emit({ type: "usage", tokens: { inputTokens: 5, outputTokens: 2 } });
  });
  await writeFile(path.join(env.repo, "package-lock.json"), "{}");
  const thread = await env.engine.create({
    kind: "repo",
    repoPath: "demo",
    prompt: "Cambia a.txt\nmás detalle",
    agent: AGENT,
  });
  assert.equal(thread.title, "Cambia a.txt");
  assert.equal(thread.status, "setting-up");
  assert.match(thread.repo.branch, /^sb\/cambia-a-txt-/);
  assert.ok(existsSync(thread.repo.worktree));
  await waitFor(() => env.log.turns.length === 1);
  await env.engine.idle(thread.id);
  // Setup ran only because the worktree has a lockfile? It does not: the
  // lockfile was written after the worktree was created from HEAD.
  assert.deepEqual(env.setups, []);
  const snap = env.engine.snapshot(thread.id);
  assert.equal(snap.thread.status, "idle");
  assert.equal(snap.thread.counters.turns, 1);
  assert.deepEqual(
    snap.items.map((i) => i.kind),
    ["user_message", "assistant_message", "command", "usage"],
  );
  assert.equal(snap.items[1].text, "Hola mundo");
  assert.equal(snap.items[2].output, "ok");
  // The repo's own checkout is untouched.
  assert.equal(await readFile(path.join(env.repo, "a.txt"), "utf8"), "uno\n");
  const diff = await env.engine.diff(thread.id);
  assert.deepEqual(
    diff.map((f) => [f.path, f.change, f.additions, f.deletions]),
    [["a.txt", "modify", 1, 1]],
  );
  const [turn] = env.store.turns(thread.id);
  assert.equal(
    (await env.engine.turnDiff(thread.id, turn.id))[0].path,
    "a.txt",
  );
  assert.equal(env.store.meta(thread.id).nativeIds.codex, "native-1");
  // The next turn resumes the provider conversation with the same controller.
  await env.engine.send(thread.id, { text: "otra", mode: "send" });
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.equal(env.log.turns[1].conversacionId, "native-1");
  assert.equal(env.log.created, 1);
});

test("setup installs dependencies when the branch has a lockfile", async (t) => {
  const env = await setup(t, async () => {});
  const git = createGit({ env: process.env }).git;
  await writeFile(path.join(env.repo, "package-lock.json"), "{}");
  await git(env.repo, ["add", "-A"]);
  await git(env.repo, ["commit", "-qm", "chore: lock"]);
  const thread = await env.engine.create({
    kind: "repo",
    repoPath: "demo",
    prompt: "x",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  await env.engine.idle(thread.id);
  assert.equal(env.setups[0][0], "npm");
  assert.ok(env.setups[0].includes("--prefer-offline"));
  const command = env.store.items(thread.id).find((i) => i.kind === "command");
  assert.equal(command.exitCode, 0);
  assert.equal(command.output, "installed\n");
});

test("steer reaches the running turn and queued messages run next", async (t) => {
  const first = gate();
  const env = await setup(
    t,
    async (_ctx, n) => {
      if (n === 1) await first.promise;
    },
    { steer: true },
  );
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "largo",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  const steered = await env.engine.send(thread.id, {
    text: "cambia",
    mode: "steer",
  });
  assert.equal(steered.delivery, "steer");
  assert.deepEqual(env.log.steers, ["cambia"]);
  const queued = await env.engine.send(thread.id, {
    text: "después",
    mode: "queue",
  });
  assert.equal(queued.delivery, "queue");
  first.open();
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.equal(env.log.turns[1].prompt, "después");
});

test("without steer support a steer is queued with a notice", async (t) => {
  const first = gate();
  const env = await setup(t, async (_ctx, n) => {
    if (n === 1) await first.promise;
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  const result = await env.engine.send(thread.id, { text: "b", mode: "steer" });
  assert.equal(result.delivery, "queue");
  first.open();
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.ok(
    env.store
      .items(thread.id)
      .some((i) => i.kind === "notice" && i.code === "steer-unsupported"),
  );
});

test("questions wait for the owner; plain approvals follow the autonomy", async (t) => {
  /** @type {any[]} */
  const answers = [];
  const env = await setup(t, async (ctx) => {
    answers.push(
      await ctx.ask("n1", {
        kind: "approval",
        title: "Ejecutar npm test",
        choices: ["accept", "decline"],
      }),
    );
    answers.push(
      await ctx.ask("n2", {
        kind: "question",
        title: "¿Rama?",
        questions: [
          {
            id: "q1",
            question: "¿Qué rama?",
            options: [{ label: "main" }, { label: "dev" }],
          },
        ],
      }),
    );
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  const request = await waitFor(() =>
    env.store.requests(thread.id).find((r) => r.status === "open"),
  );
  assert.equal(env.store.getThread(thread.id).status, "waiting-user");
  assert.deepEqual(
    env.store.inbox().map((e) => e.requestId),
    [request.id],
  );
  assert.throws(() =>
    env.engine.answer(thread.id, request.id, {
      answer: { values: { q1: "nope" } },
      origin: "app",
    }),
  );
  env.engine.answer(thread.id, request.id, {
    answer: { optionId: "dev" },
    origin: "discord",
  });
  await env.engine.idle(thread.id);
  assert.deepEqual(answers, [{ decision: "accept" }, { q1: "dev" }]);
  assert.equal(env.store.getRequest(request.id).origin, "discord");
  assert.equal(env.store.getThread(thread.id).status, "idle");
  assert.deepEqual(env.store.inbox(), []);
  assert.ok(
    env.store
      .items(thread.id)
      .some((i) => i.kind === "notice" && i.code === "auto-approved"),
  );
  assert.throws(
    () =>
      env.engine.answer(thread.id, request.id, {
        answer: { optionId: "dev" },
        origin: "app",
      }),
    /ya fue respondida/,
  );
});

test("interrupt stops the turn and cancels its open requests", async (t) => {
  const env = await setup(t, async (ctx, _n, aborted) => {
    await ctx
      .ask("n1", { kind: "question", questions: [{ id: "q", question: "?" }] })
      .catch(() => {});
    await waitFor(aborted);
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  const request = await waitFor(() =>
    env.store.requests(thread.id).find((r) => r.status === "open"),
  );
  assert.equal(env.engine.interrupt(thread.id), true);
  await env.engine.idle(thread.id);
  assert.equal(env.store.getRequest(request.id).status, "cancelled");
  assert.equal(env.store.turns(thread.id)[0].outcome, "interrupted");
  assert.equal(env.engine.interrupt(thread.id), false);
});

test("turns wait for capacity and the thread says so", async (t) => {
  const first = gate();
  const env = await setup(
    t,
    async (_ctx, n) => {
      if (n === 1) await first.promise;
    },
    { maxActive: 1 },
  );
  const a = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  const b = await env.engine.create({
    kind: "scratch",
    prompt: "b",
    agent: AGENT,
  });
  await waitFor(() => env.store.items(b.id).some((i) => i.code === "capacity"));
  assert.equal(env.log.turns.length, 1);
  first.open();
  await env.engine.idle(a.id);
  await env.engine.idle(b.id);
  assert.equal(env.log.turns.length, 2);
});

test("failed turns leave a notice; the turn limit asks for a decision", async (t) => {
  const env = await setup(t, async (_ctx, n) => {
    if (n === 1) throw new Error("boom");
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  await env.engine.idle(thread.id);
  assert.equal(env.store.turns(thread.id)[0].outcome, "failed");
  assert.ok(env.store.items(thread.id).some((i) => i.code === "turn-failed"));
  env.store.append(thread.id, [
    {
      type: "thread.updated",
      threadId: thread.id,
      at: new Date().toISOString(),
      patch: { limits: { maxTurns: 2, maxReviewRounds: 3 } },
    },
  ]);
  await env.engine.send(thread.id, { text: "b", mode: "send" });
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.equal(env.store.getThread(thread.id).status, "needs-decision");
  assert.deepEqual(
    env.store.inbox().map((e) => e.reason),
    ["needs-decision"],
  );
  // Writing again grants more turns.
  await env.engine.send(thread.id, { text: "c", mode: "send" });
  await waitFor(() => env.log.turns.length === 3);
  await env.engine.idle(thread.id);
  assert.equal(env.store.getThread(thread.id).status, "idle");
});

test("rejects unknown projects and invalid commands", async (t) => {
  const env = await setup(t, async () => {});
  await assert.rejects(
    env.engine.create({
      kind: "repo",
      repoPath: "/etc",
      prompt: "a",
      agent: AGENT,
    }),
    /Proyecto desconocido/,
  );
  await assert.rejects(
    env.engine.create({ kind: "scratch", prompt: "", agent: AGENT }),
  );
  await assert.rejects(
    env.engine.send("thr_missing000", { text: "a", mode: "send" }),
    /no encontrado/,
  );
});

test("recovers threads left running by a previous process", async (t) => {
  const env = await setup(t, async () => {});
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await env.engine.idle(thread.id);
  const at = new Date().toISOString();
  env.store.append(thread.id, [
    {
      type: "thread.updated",
      threadId: thread.id,
      at,
      patch: { status: "running" },
    },
    {
      type: "turn.started",
      threadId: thread.id,
      at,
      turnId: "trn_crashed0001",
      agent: AGENT,
      stageIndex: 0,
    },
  ]);
  env.engine.recover();
  assert.equal(env.store.getThread(thread.id).status, "idle");
  assert.equal(env.store.turns(thread.id).at(-1).outcome, "failed");
});

test("HTTP routes and the resumable SSE stream", async (t) => {
  const release = gate();
  const env = await setup(t, async (ctx) => {
    ctx.delta("m1", "par");
    await release.promise;
    ctx.message("m1", "parcial y final");
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!(await env.threads.http.handle(req, res, url))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise((r) => server.close(() => r(undefined))));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const created = await fetch(`${base}/threads`, {
    method: "POST",
    body: JSON.stringify({ kind: "scratch", prompt: "hola", agent: AGENT }),
  });
  assert.equal(created.status, 201);
  const { thread } = await created.json();
  await waitFor(() => env.engine.liveItems(thread.id).length);
  // Join mid-turn: replay from 0 plus the live item with its streamed text.
  const controller = new AbortController();
  const stream = await fetch(`${base}/threads/${thread.id}/stream?after=0`, {
    signal: controller.signal,
  });
  assert.equal(
    stream.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  const reader = stream.body.getReader();
  let text = "";
  const read = async (/** @type {(s: string) => boolean} */ until) => {
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  };
  await read((s) => s.includes('"item.snapshot"'));
  assert.match(text, /^id: 1\ndata: \{"type":"event"/);
  assert.match(text, /"text":"par"/);
  release.open();
  await read((s) => s.includes("parcial y final"));
  controller.abort();
  await env.engine.idle(thread.id);
  const last = env.store.lastSeq(thread.id);
  const ahead = await (
    await fetch(`${base}/threads/${thread.id}/stream?after=${last + 5}`)
  ).text();
  assert.match(ahead, /snapshot-required/);
  const snap = await (await fetch(`${base}/threads/${thread.id}`)).json();
  assert.equal(snap.lastSeq, last);
  const list = await (await fetch(`${base}/threads?status=idle`)).json();
  assert.deepEqual(
    list.threads.map((x) => x.id),
    [thread.id],
  );
  const sent = await fetch(`${base}/threads/${thread.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "más", mode: "send" }),
  });
  assert.equal(sent.status, 202);
  await env.engine.idle(thread.id);
  assert.equal((await fetch(`${base}/threads/thr_missing000`)).status, 404);
  assert.equal(
    (await fetch(`${base}/threads`, { method: "POST", body: "{" })).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/threads/${thread.id}/interrupt`, { method: "POST" }))
      .status,
    200,
  );
  assert.deepEqual(await (await fetch(`${base}/inbox`)).json(), {
    entries: [],
  });
  assert.equal((await fetch(`${base}/threads/${thread.id}/diff`)).status, 200);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 418);
  // Global feed replays by globalSeq.
  const globalController = new AbortController();
  const global = await fetch(`${base}/threads/stream?after=0`, {
    signal: globalController.signal,
  });
  const globalReader = global.body.getReader();
  const { value } = await globalReader.read();
  globalController.abort();
  assert.match(new TextDecoder().decode(value), /^id: 1\n/);
});
