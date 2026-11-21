import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeController } from "../lib/providers/claude.mjs";
import { createCodexController } from "../lib/providers/codex.mjs";
import { createStreamFakeProcess } from "./helpers/provider-fakes.mjs";
import {
  claudeRateLimit,
  claudeRateLimits,
  codexRateLimits,
  diffStats,
  isoTime,
  patchFromTexts,
  splitUnifiedDiff,
  stepStatus,
} from "../lib/providers/provider-events.mjs";

test("normalises step statuses across providers", () => {
  assert.deepEqual(
    [
      "inProgress",
      "in-progress",
      "in_progress",
      "active",
      "done",
      "x",
      null,
    ].map(stepStatus),
    [
      "in_progress",
      "in_progress",
      "in_progress",
      "in_progress",
      "completed",
      "pending",
      "pending",
    ],
  );
});

test("splits a multi-file git diff without flattening it", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old.js b/moved.js",
    "similarity index 100%",
    "rename from old.js",
    "rename to moved.js",
  ].join("\n");
  const files = splitUnifiedDiff(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.change, f.additions, f.deletions, f.oldPath]),
    [
      ["src/a.ts", "modify", 1, 1, undefined],
      ["new.md", "add", 1, 0, undefined],
      ["gone.txt", "delete", 0, 1, undefined],
      ["moved.js", "rename", 0, 0, "old.js"],
    ],
  );
  assert.ok(files[0]?.patch.startsWith("diff --git a/src/a.ts"));
  assert.deepEqual(splitUnifiedDiff(""), []);
  assert.deepEqual(diffStats("--- a\n+++ b\n+x\n-y\n-z\n"), {
    additions: 1,
    deletions: 2,
  });
});

test("builds a patch from whole-file texts", () => {
  const edit = patchFromTexts("a.txt", "one\ntwo\nthree", "one\n2\nthree");
  assert.equal(edit.change, "modify");
  assert.deepEqual([edit.additions, edit.deletions], [1, 1]);
  assert.match(
    edit.patch,
    /^--- a\/a.txt\n\+\+\+ b\/a.txt\n@@ -2,1 \+2,1 @@\n-two\n\+2$/,
  );
  const created = patchFromTexts("n.txt", null, "x\ny");
  assert.equal(created.change, "add");
  assert.equal(created.additions, 2);
  assert.match(created.patch, /^--- \/dev\/null/);
  assert.equal(patchFromTexts("s.txt", "same", "same").patch, "");
});

test("normalises rate limits from Claude and Codex", () => {
  assert.equal(isoTime(1795201200), "2026-11-20T19:00:00.000Z");
  assert.equal(isoTime(1795201200000), "2026-11-20T19:00:00.000Z");
  assert.equal(isoTime("nope"), null);
  assert.equal(isoTime(-1), null);
  assert.deepEqual(
    claudeRateLimit({
      status: "allowed_warning",
      resetsAt: 1795201200,
      rateLimitType: "five_hour",
      utilization: 0.81,
    }),
    {
      window: "five_hour",
      usedPercent: 81,
      resetsAt: "2026-11-20T19:00:00.000Z",
      status: "warning",
    },
  );
  assert.equal(claudeRateLimit({ status: "rejected" })?.usedPercent, 100);
  assert.equal(claudeRateLimit({ status: "allowed" })?.usedPercent, null);
  assert.equal(claudeRateLimit(undefined), null);
  // What the CLI really sends: utilization only inside unifiedWindows.
  assert.deepEqual(
    claudeRateLimits({
      status: "allowed",
      resetsAt: 1795246800,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: 1795246800, status: "allowed" },
        seven_day: { utilization: 0.22, resetsAt: 1795705200, status: "allowed" },
      },
    }).map((w) => [w.window, w.usedPercent]),
    [
      ["five_hour", 51],
      ["seven_day", 22],
    ],
  );
  assert.deepEqual(claudeRateLimits(undefined), []);
  assert.deepEqual(
    codexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 40,
          windowDurationMins: 300,
          resetsAt: 1795201200,
        },
        secondary: { usedPercent: 100, windowDurationMins: 10080 },
      },
    }).map((w) => [w.window, w.usedPercent, w.status]),
    [
      ["five_hour", 40, "allowed"],
      ["seven_day", 100, "rejected"],
    ],
  );
  assert.deepEqual(codexRateLimits(null), []);
});

/**
 * A fake Claude SDK: `script(push)` yields messages; `push` receives the
 * user messages the controller writes to the input queue.
 * @param {(io: { next: () => Promise<unknown> }) => AsyncGenerator<any>} script
 */
function fakeClaude(script) {
  return createClaudeController(({ prompt }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    return {
      async interrupt() {},
      close() {},
      [Symbol.asyncIterator]() {
        return script({
          next: async () => (await iterator.next()).value,
        });
      },
    };
  });
}

function claudeContext() {
  /** @type {any[]} */
  const emitted = [];
  /** @type {any[]} */
  const tools = [];
  /** @type {any[]} */
  const deltas = [];
  /** @type {any[]} */
  const messages = [];
  /** @type {any} */
  let control = null;
  const ctx = {
    turnId: "t1",
    session: { motor: "claude" },
    cwd: process.cwd(),
    prompt: "do it",
    attachments: [],
    mcpServers: null,
    spawn() {
      throw new Error("no spawn");
    },
    onAbort() {},
    onControl: (/** @type {any} */ c) => (control = c),
    nativeId() {},
    message: (/** @type {string} */ id, /** @type {string} */ value) =>
      messages.push([id, value]),
    delta: (/** @type {string} */ id, /** @type {string} */ value) =>
      deltas.push([id, value]),
    tool: (/** @type {string} */ id, /** @type {any} */ value) =>
      tools.push([id, value]),
    ask: async () => ({}),
    emit: (/** @type {any} */ event) => emitted.push(event),
  };
  return { ctx, emitted, tools, deltas, messages, control: () => control };
}

test("Claude emits reasoning, todos, plans, subagents, usage and limits", async () => {
  const controller = fakeClaude(async function* ({ next }) {
    await next();
    yield { type: "system", subtype: "init", session_id: "s1" };
    yield {
      type: "rate_limit_event",
      session_id: "s1",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.4,
      },
    };
    yield {
      type: "stream_event",
      session_id: "s1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hm" },
      },
    };
    yield {
      type: "assistant",
      uuid: "u1",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "thinking", thinking: "Let me plan" },
          {
            type: "tool_use",
            id: "todo1",
            name: "TodoWrite",
            input: { todos: [{ content: "Write", status: "in_progress" }] },
          },
          {
            type: "tool_use",
            id: "plan1",
            name: "ExitPlanMode",
            input: { plan: "1. a" },
          },
          {
            type: "tool_use",
            id: "task1",
            name: "Task",
            input: {
              subagent_type: "Explore",
              description: "find",
              prompt: "look",
            },
          },
          {
            type: "tool_use",
            id: "bash1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    };
    // Subagent output must not leak into the thread.
    yield {
      type: "assistant",
      uuid: "u2",
      session_id: "s1",
      parent_tool_use_id: "task1",
      message: {
        content: [
          { type: "text", text: "searching" },
          { type: "tool_use", id: "inner1", name: "Grep", input: {} },
        ],
      },
    };
    yield {
      type: "stream_event",
      session_id: "s1",
      parent_tool_use_id: "task1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "leak" },
      },
    };
    yield {
      type: "user",
      session_id: "s1",
      parent_tool_use_id: "task1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "inner1", content: "x" }],
      },
    };
    yield {
      type: "user",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "task1", content: "found it" },
          { type: "tool_result", tool_use_id: "todo1", content: "ok" },
          { type: "tool_result", tool_use_id: "bash1", content: "a.txt" },
        ],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
      total_cost_usd: 0.02,
    };
  });
  const io = claudeContext();
  const outcome = await controller.runTurn(/** @type {any} */ (io.ctx));
  assert.equal(outcome.status, "completed");
  const byType = (/** @type {string} */ type) =>
    io.emitted.filter((e) => e.type === type);
  assert.deepEqual(byType("rate_limits")[0].windows[0].usedPercent, 40);
  assert.deepEqual(
    byType("reasoning").map((e) => [e.text, Boolean(e.delta)]),
    [
      ["hm", true],
      ["Let me plan", false],
    ],
  );
  assert.deepEqual(byType("todo_list")[0].todos, [
    { text: "Write", status: "in_progress" },
  ]);
  assert.equal(byType("plan")[0].explanation, "1. a");
  assert.deepEqual(
    byType("subagent").map((e) => [
      e.id,
      e.status,
      e.activity ?? e.result ?? e.prompt,
    ]),
    [
      ["task1", "in-progress", "look"],
      ["task1", "in-progress", "searching"],
      ["task1", "completed", "found it"],
    ],
  );
  assert.deepEqual(byType("usage")[0].tokens, {
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: 3,
    costUsd: 0.02,
  });
  // Only Bash is a generic tool call; nested and absorbed tools are not.
  assert.deepEqual([...new Set(io.tools.map(([id]) => id))], ["bash1"]);
  assert.deepEqual(io.deltas, [], "subagent deltas stay out of the thread");
  assert.equal(io.control().supportsSteer, true);
  await controller.shutdown("test");
});

test("Claude steer at a tool boundary ends with one result", async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = () => r(undefined)));
  /** @type {unknown[]} */
  const inputs = [];
  const controller = fakeClaude(async function* ({ next }) {
    inputs.push(await next());
    yield { type: "system", subtype: "init", session_id: "s2" };
    yield {
      type: "assistant",
      uuid: "a",
      session_id: "s2",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }],
      },
    };
    await gate;
    inputs.push(await next());
    yield {
      type: "user",
      session_id: "s2",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "b1", content: "" }],
      },
    };
    yield { type: "result", subtype: "success", session_id: "s2", usage: {} };
  });
  const io = claudeContext();
  const running = controller.runTurn(/** @type {any} */ (io.ctx));
  while (!io.tools.length) await new Promise((r) => setTimeout(r, 5));
  await io.control().steer("change course");
  release();
  const outcome = await running;
  assert.equal(outcome.status, "completed");
  assert.equal(/** @type {any} */ (inputs[1]).message.content, "change course");
  await assert.rejects(io.control().steer("late"), /No hay un turno/);
  await controller.shutdown("test");
});

test("Claude keeps the turn open for a steer answered after a text reply", async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = () => r(undefined)));
  const controller = fakeClaude(async function* ({ next }) {
    await next();
    yield { type: "system", subtype: "init", session_id: "s3" };
    yield {
      type: "assistant",
      uuid: "m1",
      session_id: "s3",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "one two three" }] },
    };
    await gate;
    yield { type: "result", subtype: "success", session_id: "s3", usage: {} };
    await next();
    yield {
      type: "assistant",
      uuid: "m2",
      session_id: "s3",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "STEERED" }] },
    };
    yield { type: "result", subtype: "success", session_id: "s3", usage: {} };
  });
  const io = claudeContext();
  const running = controller.runTurn(/** @type {any} */ (io.ctx));
  while (!io.messages.length) await new Promise((r) => setTimeout(r, 5));
  await io.control().steer("stop");
  release();
  await running;
  assert.deepEqual(
    io.messages.map(([, text]) => text),
    ["one two three", "STEERED"],
    "the steer's answer belongs to the same turn",
  );
  await controller.shutdown("test");
});

test("Codex emits reasoning, plan, per-file diffs, commands, usage and limits", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-codex-rich-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const emitted = [];
  const turnId = "t-rich";
  const notify = (send, method, params) =>
    send({ method, params: { threadId: "thr-1", turnId, ...params } });
  const ctx = {
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "codex" },
    cwd: dir,
    prompt: "work",
    mcpServers: {},
    useCodexMcpList: false,
    systemCodexConfigDir: null,
    env: { CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir },
    operatorEnv: { CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir },
    message: () => {},
    delta: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({ decision: "cancel" }),
    emit: (event) => emitted.push(event),
    spawn() {
      return createStreamFakeProcess((msg, send) => {
        if (msg.method === "initialize")
          send({
            id: msg.id,
            result: { codexHome, userAgent: "codex-cli/test" },
          });
        else if (msg.method === "mcpServerStatus/list")
          send({ id: msg.id, result: { data: [] } });
        else if (msg.method === "config/read")
          send({ id: msg.id, result: { config: {} } });
        else if (msg.method === "thread/start")
          send({ id: msg.id, result: { thread: { id: "thr-1" } } });
        else if (msg.method === "turn/start") {
          send({ id: msg.id, result: { turn: { id: turnId } } });
          send({
            method: "turn/started",
            params: { threadId: "thr-1", turn: { id: turnId } },
          });
          notify(send, "item/reasoning/summaryTextDelta", {
            itemId: "r1",
            delta: "thi",
          });
          notify(send, "item/completed", {
            item: {
              id: "r1",
              type: "reasoning",
              summary: ["thinking"],
              content: [],
            },
          });
          notify(send, "turn/plan/updated", {
            explanation: "why",
            plan: [
              { step: "read", status: "completed" },
              { step: "edit", status: "inProgress" },
            ],
          });
          notify(send, "item/started", {
            item: {
              id: "c1",
              type: "commandExecution",
              command: "npm test",
              cwd: dir,
              status: "inProgress",
            },
          });
          notify(send, "item/commandExecution/outputDelta", {
            itemId: "c1",
            delta: "ok\n",
          });
          notify(send, "item/completed", {
            item: {
              id: "c1",
              type: "commandExecution",
              command: "npm test",
              aggregatedOutput: "ok\n",
              exitCode: 1,
              durationMs: 50,
              status: "failed",
            },
          });
          notify(send, "item/completed", {
            item: {
              id: "f1",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "a.ts",
                  kind: { type: "update" },
                  diff: "@@ -1 +1 @@\n-a\n+b",
                },
                {
                  path: "old.ts",
                  kind: { type: "update", move_path: "new.ts" },
                  diff: "",
                },
                { path: "n.ts", kind: { type: "add" }, diff: "+x\n+y" },
              ],
            },
          });
          notify(send, "item/completed", {
            item: {
              id: "s1",
              type: "collabAgentToolCall",
              tool: "spawn_agent",
              prompt: "help",
              status: "completed",
            },
          });
          notify(send, "turn/diff/updated", {
            diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b",
          });
          notify(send, "thread/tokenUsage/updated", {
            tokenUsage: {
              last: {
                inputTokens: 7,
                outputTokens: 3,
                cachedInputTokens: 2,
                reasoningOutputTokens: 1,
              },
            },
          });
          notify(send, "account/rateLimits/updated", {
            rateLimits: {
              primary: { usedPercent: 12, windowDurationMins: 300 },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: "thr-1",
              turn: { id: turnId, status: "completed" },
            },
          });
        }
      });
    },
  };
  const controller = createCodexController();
  await controller.runTurn(ctx);
  await controller.shutdown();
  const of = (type) => emitted.filter((e) => e.type === type);
  assert.deepEqual(
    of("reasoning").map((e) => [e.text, Boolean(e.delta)]),
    [
      ["thi", true],
      ["thinking", false],
    ],
  );
  assert.deepEqual(of("plan")[0].steps, [
    { text: "read", status: "completed" },
    { text: "edit", status: "in_progress" },
  ]);
  assert.equal(of("plan")[0].explanation, "why");
  assert.deepEqual(
    of("command").map((e) => [e.status, e.outputDelta ?? e.output, e.exitCode]),
    [
      ["in-progress", undefined, undefined],
      ["in-progress", "ok\n", undefined],
      ["failed", "ok\n", 1],
    ],
  );
  assert.deepEqual(
    of("file_change")[0].diffs.map((d) => [
      d.path,
      d.change,
      d.additions,
      d.deletions,
      d.oldPath,
    ]),
    [
      ["a.ts", "modify", 1, 1, undefined],
      ["new.ts", "rename", 0, 0, "old.ts"],
      ["n.ts", "add", 2, 0, undefined],
    ],
  );
  assert.equal(of("subagent")[0].prompt, "help");
  assert.equal(of("turn_diff")[0].diffs[0].path, "a.ts");
  assert.deepEqual(of("usage")[0].tokens, {
    inputTokens: 7,
    outputTokens: 3,
    cachedInputTokens: 2,
    reasoningTokens: 1,
  });
  assert.equal(of("rate_limits")[0].windows[0].window, "five_hour");
});
