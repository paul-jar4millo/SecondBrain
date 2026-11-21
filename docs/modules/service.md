# service

The HTTP API and the only writer of the vault. Node.js 24, ES modules, no
framework: `node:http` with a declarative route table and Zod schemas.

```sh
npm --prefix service test          # node:test, synthetic vaults in temp dirs
VAULT_ROOT=/tmp/vault npm run dev  # API on :5080 plus the Vite dev server
```

## Layout

| File                                        | Responsibility                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `index.mjs`                                 | Server factory, request pipeline (auth, CSRF, rate limits, body limits) and handlers |
| `routes.mjs`                                | Route table: method, path, public / room access, body schema                         |
| `auth.mjs`                                  | Owner account (scrypt), sessions, TOTP, CSRF, agent credentials                      |
| `remote-mcp.mjs`                            | OAuth 2.1 authorization server and Streamable HTTP MCP endpoint                      |
| `vault.mjs`, `vault-*.mjs`                  | Reading, parsing, validation, formatting, mutations, tasks, ledger, Git history      |
| `journal.mjs`, `history.mjs`                | Write-ahead journal and per-note history                                             |
| `finance*.mjs`                              | Finance domain: accounts, cards, cash-flow, idempotent operations, imports           |
| `approvals.mjs`                             | Approvals with idempotent receipts                                                   |
| `user-requests.mjs`, `effects-executor.mjs` | Persistent questions, effects with external consequences                             |
| `shared-files.mjs`                          | Briefcase storage, quotas, expiry and trash                                          |
| `launcher-client.mjs`                       | Client for the agent runner                                                          |
| `change-feed.mjs`                           | SSE change notifications                                                             |
| `lib/durable-store.mjs`                     | Atomic JSON writes, JSON-lines append, serial queues                                 |

## Write path

See [ADR 0001](../adr/0001-git-backed-vault-with-single-writer.md) and the
[sequence diagram](../architecture/sequences.md#writing-a-note-with-optimistic-concurrency).
Operational stores go through `lib/durable-store.mjs`: JSON documents are
written to a temporary file and renamed into place, JSON-lines records are
appended and `fsync`ed, and each store has its own serial queue so writes
never interleave.

## Security notes

- Production refuses to start without authentication; local development is
  passwordless unless `AUTH=on`.
- Agent ("room") credentials are hashed at rest, scoped to a route allow-list
  and cannot write `AGENTS.md` or the vault's `99-Meta/` rules.
- Briefcase downloads are always `Content-Disposition: attachment`.
- Request bodies are size-limited per route; JSON is capped at 12 MB.

## Tests

`service/tests/` covers auth, CSRF, OAuth, vault writes and recovery, finance,
approvals, briefcase limits, packaging and the remote MCP. Helpers
in `tests/helpers/` create synthetic vaults; tests never use real notes.

## Threads (ADR 0010)

`http/routes/threads.mjs` relays the owner's thread API to the launcher
(`launcher-threads-client.mjs`): `GET|POST /threads`, `GET /threads/detail`,
`GET /threads/stream` (SSE, resumes with `Last-Event-ID` or `?after=`),
`GET /threads/feed`, `POST /threads/messages|interrupt|answer|close|archive`,
`GET /threads/diff`, `GET /inbox` and `GET /flows` (flow templates). Agents
cannot use them.

`POST /threads` takes an optional `flowTemplateId` and `stageAgents` (agent
per stage key). The thread freezes the template's stages when it is created;
the first stage picks the agent, and a read-only stage runs its turns without
writes. DeepSeek is refused for any stage unless `SB_ALLOW_BILLED_DEEPSEEK=1`.

Each thread gets its own `sbcap_` credential (profile `ejecucion`, narrowed
by operator policy), bound to the thread id; closing without a PR or
archiving revokes it. With that credential the agent asks the owner through
`POST /threads/agent/ask` (MCP `thread_ask_user`), and the existing
`usuario_*` tools are routed to the thread: `/requests/ask`,
`/requests/detail` and `/requests/wait` accept `req_…` ids. An
answer that arrives after the turn ended starts a new turn with it.

In a multi-stage flow the agent hands the thread on with
`POST /threads/agent/handoff` (MCP `thread_handoff`, gated by `user.ask`
like the other thread tools): the launcher checks the flow's rules, waits for
the agent's turn to end, adds a `handoff` item with the brief (diffstat,
commands and exit codes, failed tests, errors, files) and starts the next
stage with its own agent and a new provider conversation.

A review stage reports its verdict with `POST /threads/agent/review` (MCP
`thread_report_review`, once per turn). When the turn ends, `approved` leaves
the thread `ready-for-review` for the owner, `changes-requested` sends it back
to the implementer with the findings as open items, and the last allowed
round (`maxReviewRounds`, 3 at most) turns it `needs-decision`.
