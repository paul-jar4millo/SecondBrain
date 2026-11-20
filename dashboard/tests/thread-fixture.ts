import type { Thread } from "../src/features/threads/thread-types";

const at = "2026-11-20T10:00:00Z";
export function fixtureThread(
  id: string,
  engine: Thread["agent"]["engine"],
  status: Thread["status"],
  parentId: string | null = null,
): Thread {
  return {
    id,
    status,
    title: id,
    agent: { engine },
    parentId,
    kind: "scratch",
    autonomy: "auto-worktree",
    repo: null,
    workspace: null,
    flow: null,
    stageIndex: 0,
    counters: { turns: 0, reviewRounds: 0, subtasks: 0 },
    limits: { maxTurns: 40, maxReviewRounds: 3 },
    lastSeq: 0,
    closeMode: null,
    prUrl: null,
    createdAt: at,
    updatedAt: at,
  };
}
