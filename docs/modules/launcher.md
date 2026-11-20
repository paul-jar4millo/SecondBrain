# launcher

The agent thread runner. It starts, observes and stops official agent CLIs
as the unprivileged user `sb-agente`, behind a loopback HTTP API with a bearer
token. The service never runs a model. Rationale:
[ADR 0003](../adr/0003-isolated-agent-sessions.md),
[ADR 0004](../adr/0004-provider-adapters.md) and
[ADR 0010](../adr/0010-threads-replace-sessions.md).

```sh
npm --prefix launcher test   # uses fake CLIs; never calls a provider
```

## Agents

| Character | Engine      | Protocol                                                     |
| --------- | ----------- | ------------------------------------------------------------ |
| Ámbar     | Claude Code | Claude Agent SDK                                             |
| Menta     | Codex       | `codex app-server` (JSON-RPC)                                |
| Lira      | Antigravity | Agent Client Protocol over stdio                             |
| Marina    | DeepSeek    | Claude Agent SDK with separate configuration and API billing |

## Layout

| File                                          | Responsibility                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `index.mjs`                                   | Start-up and HTTP API: threads plus `/estado`, `/proyectos`, `/modelos`, `/uso`, `/capacidades`, `/espacios`, `/herramientas/*` |
| `threads/`                                    | The thread engine, its SQLite store and HTTP routes (below)                                                                     |
| `provider-adapters.mjs`                       | Capability contract per engine                                                                                                  |
| `provider-controllers.mjs` → `lib/providers/` | One controller per protocol: `codex`, `claude`, `acp`, plus elicitation and config helpers                                      |
| `engines.mjs`, `models.mjs`, `usage.mjs`      | Engine capabilities, model catalog, usage windows                                                                               |
| `tool-catalog.mjs`, `limits.mjs`              | Tool profiles and skills, process limits                                                                                        |
| `version-registry.mjs`                        | Deploy marker read by the host helper; the thread launcher ignores the old session index                                        |
| `skills/`                                     | Skills offered to agents (research, verification, document production…)                                                         |

## Threads

A thread is one task:

- `store/`: `threads.sqlite` (ADR 0009). The `events` log is the source of
  truth; `items`, `turns`, `requests` and `inbox_view` are projections.
- `engine/thread-engine.ts`: commands (create, send with `send|steer|queue`,
  interrupt, answer, ask, close, archive) and the turn loop. Each repo
  thread gets a worktree on its own branch `sb/<slug>-<id>`; scratch threads
  get a private folder.
- `engine/event-mapper.ts`: provider callbacks and `ProviderEvent`s become
  items; streamed text and command output are ephemeral deltas.
- `engine/scheduler.ts`: `SB_MAX_ACTIVOS` slots, owner turns first; a
  waiting turn shows "Esperando capacidad".
- `child-env.mjs`, `provider-context.mjs`: the agent's environment (no
  supervisor tokens, external write secrets only when the profile allows
  them) and its per-thread `sbcap_` credential file.
- Autonomy `auto-worktree` approves plain command and file approvals inside
  the worktree; questions and MCP forms always wait for the owner.
- HTTP (loopback, control token): `GET|POST /threads`, `GET /threads/:id`,
  `GET /threads/:id/stream` (SSE, resumes with `Last-Event-ID` or `?after=`),
  `GET /threads/stream` (global feed by `globalSeq`), `POST
/threads/:id/messages|interrupt|requests/:rid|ask`, `GET
/threads/:id/requests/:rid`, `GET /threads/:id/diff`,
  `GET /threads/:id/turns/:tid/diff`, `GET /inbox`.

Closing (`engine/closing.ts`, `POST /threads/:id/close` with `mode`
`pr|merge|discard`, `POST /threads/:id/archive`):

- `pr` commits pending work, pushes `sb/…` and opens the pull request; the
  worktree stays for follow-ups until the thread is archived.
- `merge` computes the merge with `git merge-tree` first. A conflict or local
  edits in the base checkout change nothing and return the conflicting
  files. Otherwise the base branch fast-forwards to the merge commit (in its
  checkout when it has one) and the worktree and branch are removed.
- `discard` removes the worktree and branch, or the scratch folder.
- Archiving removes the worktree and the branch, except a branch with a PR.

The daily summary (`ops/launcher/resumen-matutino.sh`) opens a scratch
thread for Marina with `POST /threads`.
