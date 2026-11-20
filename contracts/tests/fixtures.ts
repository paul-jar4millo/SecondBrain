import type {
  Item,
  ItemKind,
  Thread,
  ThreadEvent,
  UserRequest,
} from "../src/index.ts";

export const AT = "2026-11-20T18:00:00.000Z";
export const THREAD_ID = "thr_abcdef123456";
export const TURN_ID = "trn_abcdef123456";
export const REQUEST_ID = "req_abcdef123456";

export const thread: Thread = {
  id: THREAD_ID,
  title: "Fix the inbox badge",
  kind: "repo",
  status: "idle",
  autonomy: "auto-worktree",
  agent: { engine: "codex", model: "gpt-5", effort: "medium" },
  repo: {
    path: "/srv/sb-agente/proyectos/SecondBrain",
    baseBranch: "main",
    branch: "sb/fix-inbox-badge",
    worktree: "/srv/sb-agente/worktrees/thr_abcdef123456",
  },
  workspace: null,
  parentId: null,
  flow: {
    templateId: "plan-implement-review",
    stages: [
      {
        id: "stg_abcdef123456",
        key: "implement",
        name: "Implementar",
        role: "implement",
        readOnly: false,
        agent: { engine: "codex" },
      },
    ],
    handoffs: [],
    maxReviewRounds: 3,
  },
  stageIndex: 0,
  counters: { turns: 0, reviewRounds: 0, subtasks: 0 },
  limits: { maxTurns: 40, maxReviewRounds: 3 },
  lastSeq: 1,
  closeMode: null,
  prUrl: null,
  createdAt: AT,
  updatedAt: AT,
};

export const request: UserRequest = {
  id: REQUEST_ID,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  kind: "form",
  title: "¿Qué rama base?",
  body: "Elige la rama.",
  options: [{ id: "main", label: "main" }],
  fields: [{ id: "note", label: "Nota", type: "textarea", required: false }],
  status: "open",
  answer: null,
  origin: null,
  createdAt: AT,
  answeredAt: null,
};

const base = (kind: ItemKind, n: number) => ({
  id: `itm_${kind.replace("_", "")}${n}xx`.slice(0, 30),
  threadId: THREAD_ID,
  turnId: TURN_ID,
  seq: n,
  status: "completed" as const,
  agent: { engine: "claude" as const },
  createdAt: AT,
  updatedAt: AT,
});

/** One valid item of every kind. */
export const items: { [K in ItemKind]: Extract<Item, { kind: K }> } = {
  user_message: {
    ...base("user_message", 1),
    agent: null,
    kind: "user_message",
    text: "hola",
    delivery: "steer",
    attachments: [{ name: "a.png", path: "uploads/a.png", mime: "image/png" }],
  },
  assistant_message: {
    ...base("assistant_message", 2),
    kind: "assistant_message",
    text: "Listo",
  },
  reasoning: { ...base("reasoning", 3), kind: "reasoning", text: "thinking" },
  plan: {
    ...base("plan", 4),
    kind: "plan",
    explanation: "Two steps",
    steps: [
      { text: "Read", status: "completed" },
      { text: "Write", status: "in_progress" },
    ],
  },
  todo_list: {
    ...base("todo_list", 5),
    kind: "todo_list",
    todos: [{ text: "Test", status: "pending" }],
  },
  file_change: {
    ...base("file_change", 6),
    kind: "file_change",
    diffs: [
      {
        path: "a.ts",
        change: "modify",
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        additions: 1,
        deletions: 1,
      },
      {
        path: "b.ts",
        oldPath: "c.ts",
        change: "rename",
        patch: "",
        additions: 0,
        deletions: 0,
      },
    ],
  },
  command: {
    ...base("command", 7),
    kind: "command",
    command: "npm test",
    cwd: "/tmp",
    output: "ok",
    exitCode: 0,
    durationMs: 1200,
  },
  tool_call: {
    ...base("tool_call", 8),
    kind: "tool_call",
    name: "brain_search",
    server: "secondbrain",
    input: { q: "x" },
    output: "[]",
  },
  user_request: {
    ...base("user_request", 9),
    kind: "user_request",
    requestId: REQUEST_ID,
  },
  subagent: {
    ...base("subagent", 10),
    kind: "subagent",
    name: "Explore",
    prompt: "find",
    result: "found",
  },
  handoff: {
    ...base("handoff", 11),
    kind: "handoff",
    handoffId: "hof_abcdef123456",
    fromStage: 0,
    toStage: 1,
    narrative: "Implemented; please review",
    openItems: ["edge case"],
    brief: {
      diffstat: [{ path: "a.ts", additions: 1, deletions: 1 }],
      commands: [{ command: "npm test", exitCode: 0 }],
      failedTests: [],
      errors: [],
      files: ["a.ts"],
    },
  },
  review: {
    ...base("review", 12),
    kind: "review",
    reviewId: "rev_abcdef123456",
    round: 1,
    verdict: "changes-requested",
    summary: "One bug",
    findings: [
      { file: "a.ts", line: 3, severity: "major", text: "Off by one" },
    ],
  },
  notice: {
    ...base("notice", 13),
    kind: "notice",
    level: "warning",
    code: "capacity",
    text: "Esperando capacidad",
  },
  usage: {
    ...base("usage", 14),
    kind: "usage",
    tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    rateLimits: [
      {
        window: "five_hour",
        usedPercent: 42,
        resetsAt: AT,
        status: "allowed",
      },
    ],
  },
};

const envelope = (seq: number) => ({
  threadId: THREAD_ID,
  seq,
  globalSeq: 100 + seq,
  at: AT,
});

/** One valid event of every type. */
export const events: ThreadEvent[] = [
  { ...envelope(1), type: "thread.created", thread },
  { ...envelope(2), type: "thread.updated", patch: { status: "running" } },
  {
    ...envelope(3),
    type: "turn.started",
    turnId: TURN_ID,
    agent: { engine: "codex" },
    stageIndex: 0,
  },
  { ...envelope(4), type: "item.started", item: items.assistant_message },
  { ...envelope(5), type: "item.updated", item: items.plan },
  { ...envelope(6), type: "item.completed", item: items.command },
  { ...envelope(7), type: "request.opened", request },
  {
    ...envelope(8),
    type: "request.resolved",
    requestId: REQUEST_ID,
    status: "answered",
    answer: { optionId: "main" },
    origin: "discord",
  },
  {
    ...envelope(9),
    type: "turn.completed",
    turnId: TURN_ID,
    outcome: "interrupted",
  },
];
