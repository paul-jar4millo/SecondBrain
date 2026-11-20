# 0010 · Threads replace sessions, PTY terminals and `sb-hilo`

- Status: accepted
- Date: 2026-11-20
- Supersedes: the session model of
  [ADR 0003](0003-isolated-agent-sessions.md) (isolation under `sb-agente`
  stays) and the work orders of [ADR 0005](0005-team-manifests.md) (spending
  and process limits stay).

## Context and problem statement

The agent chat mixes three models: PTY terminal sessions, provider
conversations where each message starts a `continuar` session, and team work
orders. Items are only `user|assistant|tool`; reasoning, plans, todo lists,
diffs and usage are dropped. The composer disappears while the agent works
even though the launcher can steer and queue. Hand-offs between agents have
no shared record.

## Decision drivers

- One unit of work the owner can follow, steer, review and close.
- Rich provider events (reasoning, plan, diffs, usage, rate limits).
- Autonomous hand-offs and cross review between agents with hard limits.
- Delete what the new model replaces instead of keeping two chats.

## Considered options

1. Extend sessions and conversations with more item types.
2. Embed a third-party agent UI (rejected again by
   [ADR 0004](0004-provider-adapters.md)).
3. A thread model: one thread is one task, with its own worktree, an event
   log, flows of stages and a close step.

## Decision outcome

Chosen option 3.

- A thread is `repo` (Git worktree on a real branch `sb/<slug>`) or
  `scratch` (a workspace folder). Default autonomy: automatic inside its own
  worktree.
- Commands: create, send (`send|steer|queue`), interrupt, answer request,
  close (`pr|merge|discard`), archive, approve subtask.
- Flows are chosen per thread; agents hand off through MCP
  (`thread_handoff`); reviews run read-only with at most three rounds and a
  turn limit, then the thread waits for a decision.
- Removed: PTY terminals (`terminal.py`, `@xterm/*`), sessions and
  conversations, `sb-hilo`, team work orders and `equipo_*` MCP tools.
  `usuario_*` tools stay as aliases of `thread_ask_user`.
- Old operational data is deleted without backup, after the owner confirms
  the list on the host.

Steering, verified with the Claude Agent SDK 0.3.326 on LXC 204: a message
pushed to the input queue during a tool-using turn is taken at the next tool
boundary (one result, and the model follows the new message); during a
text-only turn it is answered after the current result. The UI labels steer
as "applies at the next step". Codex and ACP steer through their own RPC.

Worktree cost on LXC 204: `git worktree add -b` ≈ 50 ms, removal ≈ 160 ms;
`npm ci --prefer-offline` with the shared cache ≈ 3.3 s and ≈ 270 MB for the
dashboard. Setup runs only when a lockfile exists, and archiving deletes the
worktree.

### Consequences

- Good: one chat, resumable streams, auditable hand-offs.
- Bad: a large deletion; it lands only after the end-to-end checklist passes,
  and rollback uses the previous release symlink.
- "Automatic in its worktree" is not a sandbox: process isolation still comes
  from ADR 0003.
