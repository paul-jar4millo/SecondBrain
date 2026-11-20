# lanzador

The agent session runner. It starts, observes and cancels official agent CLIs
as the unprivileged user `sb-agente`, behind a loopback HTTP API with a bearer
token. The service never runs a model. Rationale:
[ADR 0003](../adr/0003-isolated-agent-sessions.md) and
[ADR 0004](../adr/0004-provider-adapters.md).

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

| File                                          | Responsibility                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `index.mjs`                                   | Start-up, HTTP API (`/sesiones`, `/estado`, `/modelos`, `/uso`, `/capacidades`, `/espacios`…) |
| `executor.mjs`                                | Session lifecycle, turns, queues, limits                                                      |
| `provider-adapters.mjs`                       | Capability contract per engine                                                                |
| `provider-controllers.mjs` → `lib/providers/` | One controller per protocol: `codex`, `claude`, `acp`, plus elicitation and config helpers    |
| `provider-conversations.mjs`                  | Normalized conversation items, persisted atomically                                           |
| `checkpoints.mjs`                             | Working-tree snapshots in private Git refs before each turn; revert and diff                  |
| `pr.mjs`                                      | Branch, commit, push and `gh pr create` for a session's changes                               |
| `teams.mjs`, `limits.mjs`                     | Teams, manifests, process limits and resource queue                                           |
| `engines.mjs`, `models.mjs`, `usage.mjs`      | Engine capabilities, model catalog, usage windows                                             |
| `cli.mjs`                                     | `sb-hilo`: start and follow sessions from a terminal or cron                                  |
| `skills/`                                     | Skills offered to agents (research, verification, document production…)                       |

## Checkpoints, diffs and pull requests

Before every turn in a Git working tree, `checkpoints.mjs` stores the full
tree (tracked and untracked, respecting `.gitignore`) as a commit under
`refs/secondbrain/checkpoints/<session>/<n>`, using its own index file. It
never touches the user's index, branch, stash or `HEAD`. Sessions can revert
files to any checkpoint, see a diff between two, and open a pull request
whose title follows Conventional Commits.

## Terminal client

```sh
sb-hilo iniciar --agente menta --proyecto my-app --wait "Fix the failing service test"
sb-hilo enviar <id> "Now add a regression test" --wait --timeout 600
sb-hilo diff <id>
sb-hilo pr <id> --borrador
```

`--wait` exits `0` on success, `1` on failure, `124` on timeout and `2` on
incorrect usage.
