import { z } from "zod";
import { AgentRef } from "./agents.ts";
import { ThreadFlow } from "./flows.ts";
import { Seq, ThreadId, Timestamp } from "./ids.ts";

export const ThreadKind = z.enum(["repo", "scratch"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const THREAD_STATUSES = [
  "setting-up",
  "idle",
  "running",
  "waiting-user",
  "in-review",
  "ready-for-review",
  "needs-decision",
  "closing",
  "done",
  "failed",
  "archived",
] as const;
export const ThreadStatus = z.enum(THREAD_STATUSES);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/** Statuses after which no turn can start. */
export const TERMINAL_STATUSES: readonly ThreadStatus[] = [
  "done",
  "failed",
  "archived",
];

/**
 * auto-worktree: the agent acts without asking inside its own worktree.
 * ask: interceptable actions (Codex/ACP approvals, Claude canUseTool) wait
 * for the owner. read-only: no writes (review stages).
 */
export const Autonomy = z.enum(["auto-worktree", "ask", "read-only"]);
export type Autonomy = z.infer<typeof Autonomy>;

export const CloseMode = z.enum(["pr", "merge", "discard"]);
export type CloseMode = z.infer<typeof CloseMode>;

export const RepoWorkspace = z.object({
  path: z.string().min(1),
  baseBranch: z.string().min(1),
  branch: z.string().regex(/^sb\/[A-Za-z0-9._/-]+$/),
  worktree: z.string().min(1),
});

export const ThreadCounters = z.object({
  turns: z.int().min(0),
  reviewRounds: z.int().min(0),
  subtasks: z.int().min(0),
});

export const ThreadLimits = z.object({
  maxTurns: z.int().min(1),
  maxReviewRounds: z.int().min(0).max(3),
});

export const Thread = z
  .object({
    id: ThreadId,
    title: z.string().min(1).max(200),
    kind: ThreadKind,
    status: ThreadStatus,
    autonomy: Autonomy,
    agent: AgentRef,
    repo: RepoWorkspace.nullable(),
    workspace: z.string().min(1).nullable(),
    parentId: ThreadId.nullable(),
    flow: ThreadFlow.nullable(),
    stageIndex: z.int().min(0),
    counters: ThreadCounters,
    limits: ThreadLimits,
    lastSeq: Seq,
    closeMode: CloseMode.nullable(),
    prUrl: z.url().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((t) => (t.kind === "repo") === (t.repo !== null), {
    message: "Repo threads need a repo workspace and scratch threads none",
    path: ["repo"],
  });
export type Thread = z.infer<typeof Thread>;

/** Fields an event may change after creation. */
export const ThreadPatch = z
  .object({
    title: z.string().min(1).max(200),
    status: ThreadStatus,
    autonomy: Autonomy,
    agent: AgentRef,
    stageIndex: z.int().min(0),
    counters: ThreadCounters,
    limits: ThreadLimits,
    closeMode: CloseMode.nullable(),
    prUrl: z.url().nullable(),
  })
  .partial();
export type ThreadPatch = z.infer<typeof ThreadPatch>;
