# Roadmap

Status as of v0.8.0 (2026-11-21). Released work is in the
[changelog](../CHANGELOG.md); open work is tracked as
[GitHub issues](https://github.com/paul-jar4millo/SecondBrain/issues) grouped
by milestone.

## Done

| Phase               | What shipped                                                                                                                                                                                   | Releases      | Decisions                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation          | Single-writer vault API, auth, finance ledger, MCP server, isolated agent runner, 3D refuge, offline PWA, tag-gated CD                                                                         | v0.1 – v0.3   | [0001](adr/0001-git-backed-vault-with-single-writer.md)–[0008](adr/0008-npm-workspaces.md), [0012](adr/0012-vault-in-its-own-repository.md)–[0015](adr/0015-tag-gated-deployment.md), [0018](adr/0018-authentication-in-the-service.md) |
| A · Threads         | `contracts/`, SQLite event store, thread engine with worktrees, steer and SSE resume, close by PR/merge/discard, per-thread credentials, Threads UI; sessions, PTY terminals and teams removed | v0.4          | [0009](adr/0009-operational-state-in-sqlite.md), [0010](adr/0010-threads-replace-sessions.md), [0011](adr/0011-native-typescript-and-contracts.md)                                                                                      |
| 1.5 · Robust deploy | Service image on Podman by digest, self-verifying deploy with rollback, pinned agent CLIs tested in CI, English host layout with a reversible migration                                        | v0.5 – v0.6   | [0014](adr/0014-container-service-native-launcher.md), [0016](adr/0016-pinned-agent-clis.md), [0017](adr/0017-english-host-layout.md)                                                                                                   |
| B · Multi-agent     | Flow templates, autonomous hand-off, cross review (3 rounds max), subtasks with approval and integration, plan usage from provider events; fixes from a QA pass with real agents               | v0.7 – v0.7.1 | [0010](adr/0010-threads-replace-sessions.md)                                                                                                                                                                                            |

What was learned along the way, and why phase 1.5 was inserted before
multi-agent work, is in [ADR 0014](adr/0014-container-service-native-launcher.md)
and [ADR 0016](adr/0016-pinned-agent-clis.md).

## Next

### C · Notifications and Discord

- **C1 Dispatcher** (done). The service follows the launcher's global feed
  from its own cursor and keeps an outbox of what needs the owner: open
  request, needs decision, ready for review, failed, hand-off. Unread badge on
  Threads.
- **C2 Web push** (done). VAPID keys generated in the service's data
  directory, `/api/v1/push/subscriptions`, `push` and `notificationclick`
  in the service worker that open `/threads/:id`; opt-in in Settings.
- **C3 Refuge state** (done). Each character follows the agent of its
  thread's current stage and shows its state; a click opens the thread. It
  never invents work.
- **C4 Discord bot skeleton.** A `discord/` module that only talks to the
  service API with a loopback-only `bot` credential (read threads, create,
  message, answer requests, read the inbox; close, merge and settings are
  denied by policy, with a test). Owner-id filter, its own systemd unit and a
  token file readable only by root.
- **C5 Discord interactions.** One Discord thread per SecondBrain thread with
  summarized items; buttons and modals to approve, answer and steer. Merge and
  pull requests link to the app.

### D · Daily summary

- **D1** `/api/v1/summary/daily` and a scheduled morning post: threads done,
  running and blocked; usage and cost per agent; pending decisions by age;
  hygiene (idle threads, orphan worktrees, disk use). Missed runs are caught
  up.
- **D2** Suggestions from a read-only scratch thread on a low-cost
  subscription model: one to three structured suggestions, each with a button
  to start it.

### Engineering debt

- Raise MCP and dashboard coverage; convert the remaining `.js` files in the
  3D scene to TypeScript so they are measured.
- Extend type checking to the remaining Node files.

## Risks kept in view

- `SB_MAX_ACTIVE_TURNS` slots versus reviews and subtasks: owner turns go first,
  and waiting turns show "waiting for capacity".
- Memory: the launcher is capped at 3 GB and each turn at 1 GB; idle provider
  controllers expire.
- "Automatic inside its worktree" is not a sandbox; process isolation comes
  from [ADR 0003](adr/0003-isolated-agent-sessions.md).
- The Discord bot widens the attack surface; it gets an owner filter, a
  loopback credential and hard denials for closing, merging and settings.
