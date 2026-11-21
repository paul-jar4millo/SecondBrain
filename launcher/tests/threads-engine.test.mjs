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
  const contexts = /** @type {any[]} */ ([]);
  return {
    setups,
    contexts,
    context: {
      async buildAgentContext(
        /** @type {any} */ { threadId, agent, cwd, readOnly },
      ) {
        contexts.push({ agent, readOnly });
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
  const { context, setups, contexts } = fakeContext();
  const threads = openThreads({
    env: {},
    dataDir,
    projects: { demo: repo },
    git: createGit({ env: process.env }).git,
    gh: async () => {
      throw new Error("gh no está disponible en las pruebas");
    },
    maxActive: options.maxActive ?? 2,
    controllers,
    context,
    ...(options.stallNoticeMs ? { stallNoticeMs: options.stallNoticeMs } : {}),
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
    contexts,
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

test("a stop keeps queued messages for the owner's next message", async (t) => {
  const env = await setup(t, async (_ctx, n, aborted) => {
    if (n === 1) await waitFor(aborted);
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "primero",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  await env.engine.send(thread.id, { text: "en cola", mode: "queue" });
  assert.equal(env.engine.interrupt(thread.id), true);
  await env.engine.idle(thread.id);
  // Nothing runs on its own after a stop.
  assert.equal(env.log.turns.length, 1);
  assert.ok(
    env.engine
      .snapshot(thread.id)
      .items.some(
        (/** @type {any} */ i) =>
          i.kind === "notice" && i.code === "queue-held",
      ),
  );
  await env.engine.send(thread.id, { text: "sigue", mode: "send" });
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.match(env.log.turns[1].prompt, /^en cola\n\nsigue$/);
});

test("a silent turn says so once", async (t) => {
  const release = gate();
  const env = await setup(
    t,
    async () => {
      await release.promise;
    },
    { stallNoticeMs: 50 },
  );
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "piensa",
    agent: AGENT,
  });
  const stalled = () =>
    env.engine
      .snapshot(thread.id)
      .items.filter(
        (/** @type {any} */ i) =>
          i.kind === "notice" && i.code === "turn-stalled",
      );
  await waitFor(() => stalled().length === 1);
  await new Promise((r) => setTimeout(r, 150));
  release.open();
  await env.engine.idle(thread.id);
  assert.equal(stalled().length, 1);
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
  assert.equal(list.globalSeq, env.store.lastGlobalSeq());
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
  const { flows } = await (await fetch(`${base}/flows`)).json();
  assert.deepEqual(
    flows.map((/** @type {any} */ f) => f.id),
    ["single", "plan-implement-review"],
  );
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

test("agent questions outlive the turn and their answer starts a new one", async (t) => {
  const env = await setup(t, async () => {});
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length === 1);
  await env.engine.idle(thread.id);
  const request = env.engine.askUser(thread.id, {
    title: "¿Qué base de datos?",
    options: ["SQLite", "Postgres"],
  });
  assert.equal(request.kind, "question");
  assert.deepEqual(request.options, [
    { id: "o1", label: "SQLite" },
    { id: "o2", label: "Postgres" },
  ]);
  assert.equal(env.store.getThread(thread.id).status, "waiting-user");
  // A restart keeps the agent's question open.
  env.engine.recover();
  assert.equal(env.engine.request(thread.id, request.id).status, "open");
  assert.equal(env.store.getThread(thread.id).status, "waiting-user");
  env.engine.answer(thread.id, request.id, {
    answer: { optionId: "o2", text: "con réplica" },
    origin: "app",
  });
  await waitFor(() => env.log.turns.length === 2);
  await env.engine.idle(thread.id);
  assert.equal(
    env.log.turns[1].prompt,
    `Respuesta a «¿Qué base de datos?» (${request.id}):\nPostgres\ncon réplica`,
  );
  assert.equal(env.engine.request(thread.id, request.id).status, "answered");
  assert.equal(env.store.getThread(thread.id).status, "idle");
  assert.throws(() => env.engine.askUser(thread.id, { title: "" }));
  assert.throws(
    () => env.engine.request(thread.id, "req_missing000"),
    /no encontrada/,
  );
});

test("an agent question during a turn is answered without a new turn", async (t) => {
  /** @type {any} */
  let asked;
  const env = await setup(t, async (_ctx, n) => {
    if (n !== 1) return;
    asked = env.engine.askUser(_ctx.session.id, {
      title: "Datos",
      fields: [{ id: "name", label: "Nombre", type: "text", required: true }],
    });
    await waitFor(
      () => env.engine.request(_ctx.session.id, asked.id).status === "answered",
    );
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => asked);
  assert.equal(asked.kind, "form");
  assert.equal(env.store.getThread(thread.id).status, "running");
  env.engine.answer(thread.id, asked.id, {
    answer: { values: { name: "Ana" } },
    origin: "app",
  });
  await env.engine.idle(thread.id);
  assert.equal(env.log.turns.length, 1);
  assert.equal(env.store.getThread(thread.id).status, "idle");
});

test("the service may choose the thread id", async (t) => {
  const env = await setup(t, async () => {});
  const thread = await env.engine.create({
    threadId: "thr_chosen00000001",
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  assert.equal(thread.id, "thr_chosen00000001");
  await env.engine.idle(thread.id);
  await assert.rejects(
    env.engine.create({
      threadId: thread.id,
      kind: "scratch",
      prompt: "a",
      agent: AGENT,
    }),
    /ya existe/,
  );
  await assert.rejects(
    env.engine.create({
      threadId: "../x",
      kind: "scratch",
      prompt: "a",
      agent: AGENT,
    }),
    /inválido/,
  );
});

test("a flow freezes its stages and the first stage picks agent and access", async (t) => {
  const env = await setup(t, async () => {});
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "plan it",
    agent: AGENT,
    flowTemplateId: "plan-implement-review",
    stageAgents: { plan: { engine: "claude", model: "opus" } },
  });
  assert.equal(thread.flow.templateId, "plan-implement-review");
  assert.deepEqual(
    thread.flow.stages.map((/** @type {any} */ s) => [s.key, s.readOnly]),
    [
      ["plan", true],
      ["implement", false],
      ["review", true],
    ],
  );
  assert.deepEqual(thread.flow.stages[1].agent, AGENT);
  assert.deepEqual(thread.agent, { engine: "claude", model: "opus" });
  assert.equal(thread.stageIndex, 0);
  assert.equal(thread.limits.maxReviewRounds, 3);
  assert.equal(thread.autonomy, "auto-worktree");
  await waitFor(() => env.contexts.length);
  assert.deepEqual(env.contexts[0], {
    agent: { engine: "claude", model: "opus" },
    readOnly: true,
  });
  assert.deepEqual(env.store.getThread(thread.id).flow, thread.flow);
});

test("flows reject unknown templates and stages", async (t) => {
  const env = await setup(t, async () => {});
  await assert.rejects(
    env.engine.create({
      kind: "scratch",
      prompt: "a",
      agent: AGENT,
      flowTemplateId: "nope",
    }),
    /Flujo desconocido/,
  );
  await assert.rejects(
    env.engine.create({
      kind: "scratch",
      prompt: "a",
      agent: AGENT,
      flowTemplateId: "single",
      stageAgents: { review: AGENT },
    }),
    /Etapa desconocida/,
  );
  await assert.rejects(
    env.engine.create({
      kind: "scratch",
      prompt: "a",
      agent: AGENT,
      stageAgents: { plan: AGENT },
    }),
    /requiere un flujo/,
  );
  const single = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
    flowTemplateId: "single",
  });
  assert.equal(single.limits.maxReviewRounds, 0);
  await waitFor(() => env.contexts.length);
  assert.equal(env.contexts[0].readOnly, false);
});

test("a hand-off moves the thread to the next stage with a brief and a new conversation", async (t) => {
  /** @type {any} */
  let env;
  /** @type {any} */
  let rejected;
  env = await setup(
    t,
    async (/** @type {any} */ ctx, /** @type {number} */ n) => {
      if (n !== 1) return;
      ctx.nativeId("plan-conversation");
      rejected = await Promise.resolve()
        .then(() =>
          env.engine.handoff(ctx.session.id, {
            toStage: "review",
            narrative: "x",
          }),
        )
        .catch((/** @type {Error} */ e) => e);
      ctx.emit({
        type: "command",
        id: "c1",
        command: "npm test",
        output: "1 failing",
        exitCode: 1,
        status: "failed",
      });
      const accepted = env.engine.handoff(ctx.session.id, {
        toStage: "implement",
        narrative: "Plan listo: tocar el parser.",
        openItems: ["Cubrir el caso vacío"],
      });
      assert.equal(accepted.accepted, true);
    },
  );
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "Arregla el parser",
    agent: AGENT,
    flowTemplateId: "plan-implement-review",
    stageAgents: { implement: { engine: "claude" } },
  });
  await waitFor(() => env.log.turns.length >= 2);
  await env.engine.idle(thread.id);
  assert.match(rejected.message, /solo puedes pasar a: implement/);
  assert.throws(
    () => env.engine.handoff(thread.id, { toStage: "review", narrative: "x" }),
    /durante tu turno/,
  );
  const [first, second] = env.log.turns;
  assert.match(first.prompt, /etapa 1\/3 «Planificar»/);
  assert.match(first.prompt, /thread_handoff/);
  assert.match(first.prompt, /Arregla el parser$/);
  assert.match(second.prompt, /etapa 2\/3 «Implementar»/);
  assert.match(second.prompt, /Traspaso desde la etapa «Planificar»/);
  assert.match(second.prompt, /Plan listo: tocar el parser\./);
  assert.match(second.prompt, /- Cubrir el caso vacío/);
  assert.equal(second.conversacionId, null);
  assert.deepEqual(
    env.contexts.map((/** @type {any} */ c) => [c.agent.engine, c.readOnly]),
    [
      ["codex", true],
      ["claude", false],
    ],
  );
  const after = env.store.getThread(thread.id);
  assert.equal(after.stageIndex, 1);
  assert.deepEqual(after.agent, { engine: "claude" });
  const handoff = env.engine
    .snapshot(thread.id)
    .items.find((/** @type {any} */ i) => i.kind === "handoff");
  assert.equal(handoff.fromStage, 0);
  assert.equal(handoff.toStage, 1);
  assert.deepEqual(handoff.openItems, ["Cubrir el caso vacío"]);
  assert.deepEqual(handoff.brief.failedTests, ["npm test"]);
  assert.deepEqual(handoff.brief.commands, [
    { command: "npm test", exitCode: 1 },
  ]);
  assert.match(second.prompt, /Tests que fallaron:\n- npm test/);
});

test("a thread without a multi-stage flow cannot hand off", async (t) => {
  /** @type {any} */
  let env;
  /** @type {any} */
  let error;
  env = await setup(t, async (/** @type {any} */ ctx) => {
    error = await Promise.resolve()
      .then(() =>
        env.engine.handoff(ctx.session.id, {
          toStage: "implement",
          narrative: "x",
        }),
      )
      .catch((/** @type {Error} */ e) => e);
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  await waitFor(() => env.log.turns.length);
  await env.engine.idle(thread.id);
  assert.match(error.message, /no tiene un flujo/);
  assert.equal(env.store.getThread(thread.id).stageIndex, 0);
});

/** Plan → implement → review with a reviewer whose verdicts come in order. */
async function reviewFlow(t, /** @type {string[]} */ verdicts) {
  /** @type {any} */
  let env;
  const errors = /** @type {string[]} */ ([]);
  let reviews = 0;
  env = await setup(t, async (/** @type {any} */ ctx) => {
    const thread = env.store.getThread(ctx.session.id);
    const stage = thread.flow.stages[thread.stageIndex].key;
    if (stage === "plan") {
      try {
        env.engine.reportReview(ctx.session.id, {
          verdict: "approved",
          summary: "x",
        });
      } catch (/** @type {any} */ e) {
        errors.push(e.message);
      }
      env.engine.handoff(ctx.session.id, {
        toStage: "implement",
        narrative: "plan",
      });
    } else if (stage === "implement")
      env.engine.handoff(ctx.session.id, {
        toStage: "review",
        narrative: "hecho",
      });
    else {
      const verdict = verdicts[reviews++] ?? "approved";
      env.engine.reportReview(ctx.session.id, {
        verdict,
        summary: `veredicto ${reviews}`,
        findings:
          verdict === "changes-requested"
            ? [
                {
                  file: "a.js",
                  line: 3,
                  severity: "major",
                  text: "falta el caso vacío",
                },
              ]
            : [],
      });
      try {
        env.engine.reportReview(ctx.session.id, {
          verdict,
          summary: "otra vez",
        });
      } catch (/** @type {any} */ e) {
        errors.push(e.message);
      }
    }
  });
  const thread = await env.engine.create({
    kind: "scratch",
    prompt: "Arregla el parser",
    agent: AGENT,
    flowTemplateId: "plan-implement-review",
  });
  return { env, thread, errors };
}

test("review sends changes back to the implementer and approval waits for the owner", async (t) => {
  const { env, thread, errors } = await reviewFlow(t, [
    "changes-requested",
    "approved",
  ]);
  await waitFor(
    () => env.store.getThread(thread.id).status === "ready-for-review",
  );
  await env.engine.idle(thread.id);
  const turns = env.log.turns;
  assert.equal(turns.length, 5);
  assert.match(turns[2].prompt, /thread_report_review/);
  assert.match(turns[2].prompt, /pidió cambios 0 de un máximo de 3/);
  assert.match(
    turns[2].prompt,
    /La tarea original del dueño:\n> Arregla el parser/,
  );
  assert.match(turns[3].prompt, /etapa 2\/3 «Implementar»/);
  assert.match(turns[3].prompt, /Revisión 1: pide cambios \(1 de 3\)/);
  assert.match(turns[3].prompt, /- major: a\.js:3 — falta el caso vacío/);
  assert.match(turns[4].prompt, /pidió cambios 1 de un máximo de 3/);
  const after = env.store.getThread(thread.id);
  assert.equal(after.stageIndex, 2);
  // Only the request for changes counts against the limit.
  assert.equal(after.counters.reviewRounds, 1);
  const items = env.engine.snapshot(thread.id).items;
  assert.deepEqual(
    items
      .filter((/** @type {any} */ i) => i.kind === "review")
      .map((/** @type {any} */ i) => [i.round, i.verdict]),
    [
      [1, "changes-requested"],
      [2, "approved"],
    ],
  );
  assert.match(errors[0], /Solo la etapa de revisión/);
  assert.match(errors[1], /Ya reportaste/);
});

test("the third request for changes asks the owner to decide", async (t) => {
  const { env, thread } = await reviewFlow(t, [
    "changes-requested",
    "changes-requested",
    "changes-requested",
  ]);
  await waitFor(
    () => env.store.getThread(thread.id).status === "needs-decision",
  );
  await env.engine.idle(thread.id);
  assert.equal(env.log.turns.length, 7);
  const after = env.store.getThread(thread.id);
  assert.equal(after.stageIndex, 2);
  assert.equal(after.counters.reviewRounds, 3);
  assert.ok(
    env.engine
      .snapshot(thread.id)
      .items.some(
        (/** @type {any} */ i) =>
          i.kind === "notice" && i.code === "review-limit",
      ),
  );
});

test("an approved subtask works on a child branch and integrates into the parent", async (t) => {
  /** @type {any} */
  let env;
  env = await setup(t, async (/** @type {any} */ ctx) => {
    const thread = env.store.getThread(ctx.session.id);
    if (thread.parentId)
      await writeFile(path.join(ctx.cwd, "subtarea.txt"), "de la sub-tarea\n");
    else if (thread.counters.turns === 1) {
      env.engine.requestSubtask(thread.id, {
        title: "Docs",
        prompt: "Escribe subtarea.txt",
        reason: "Va en paralelo",
      });
      env.engine.requestSubtask(thread.id, {
        title: "Otra",
        prompt: "No hace falta",
      });
    }
  });
  const parent = await env.engine.create({
    kind: "repo",
    repoPath: "demo",
    prompt: "Trabajo principal",
    agent: AGENT,
  });
  await waitFor(() => env.store.getThread(parent.id).status === "waiting-user");
  await env.engine.idle(parent.id);
  const [docs, other] = env.store.requests(parent.id);
  assert.equal(docs.kind, "subtask");
  assert.deepEqual(docs.subtask, {
    title: "Docs",
    prompt: "Escribe subtarea.txt",
    agent: AGENT,
  });
  assert.match(docs.body, /Va en paralelo/);
  assert.throws(
    () =>
      env.engine.answer(parent.id, docs.id, {
        answer: { approved: true },
        origin: "app",
      }),
    /answerSubtask/,
  );
  // A double click: the second answer arrives while the child is created.
  const [answered, twice] = await Promise.allSettled([
    env.engine.answerSubtask(parent.id, docs.id, {
      answer: { approved: true },
      origin: "app",
      childId: "thr_childsubtask01",
    }),
    env.engine.answerSubtask(parent.id, docs.id, {
      answer: { approved: true },
      origin: "app",
      childId: "thr_childsubtask02",
    }),
  ]).then(([a, b]) => {
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected");
    assert.match(
      String(/** @type {any} */ (b).reason?.message),
      /ya se respondió/,
    );
    return [/** @type {any} */ (a).value, b];
  });
  assert.ok(twice);
  assert.equal(env.store.getThread("thr_childsubtask02"), null);
  assert.equal(answered.status, "answered");
  const child = env.store.getThread("thr_childsubtask01");
  assert.equal(child.parentId, parent.id);
  assert.equal(child.repo.baseBranch, parent.repo.branch);
  await env.engine.answerSubtask(parent.id, other.id, {
    answer: { approved: false, text: "No hace falta." },
    origin: "app",
  });
  await waitFor(() => env.log.turns.length >= 4);
  await env.engine.idle(child.id);
  await env.engine.idle(parent.id);
  await env.engine.idle(child.id);
  await env.engine.idle(parent.id);
  const messages = env.engine
    .snapshot(parent.id)
    .items.filter((/** @type {any} */ i) => i.kind === "user_message")
    .map((/** @type {any} */ i) => i.text);
  assert.ok(
    messages.some((m) => /«Docs» aprobada: thread thr_childsubtask01/.test(m)),
  );
  assert.ok(messages.some((m) => /«Otra» rechazada.*No hace falta\./.test(m)));
  assert.equal(env.store.getThread(parent.id).counters.subtasks, 1);
  const [status] = await env.engine.subtasks(parent.id);
  assert.equal(status.id, child.id);
  assert.deepEqual(status.diffstat, [
    { path: "subtarea.txt", additions: 1, deletions: 0 },
  ]);
  await assert.rejects(
    env.engine.integrateSubtask(child.id, parent.id),
    /no encontrada/,
  );
  const result = await env.engine.integrateSubtask(parent.id, child.id);
  assert.equal(result.thread.status, "done");
  assert.equal(
    await readFile(path.join(parent.repo.worktree, "subtarea.txt"), "utf8"),
    "de la sub-tarea\n",
  );
  assert.equal(existsSync(child.repo.worktree), false);
});

test("subtasks need a repo thread and cannot nest", async (t) => {
  const env = await setup(t, async () => {});
  const scratch = await env.engine.create({
    kind: "scratch",
    prompt: "a",
    agent: AGENT,
  });
  assert.throws(
    () => env.engine.requestSubtask(scratch.id, { title: "x", prompt: "y" }),
    /thread de repositorio/,
  );
});
