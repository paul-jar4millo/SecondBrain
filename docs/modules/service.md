# service

The HTTP API and the only writer of the vault. Node.js 24, ES modules, no
framework: `node:http` with a declarative route table and Zod schemas.

```sh
npm --prefix service test          # node:test, synthetic vaults in temp dirs
VAULT_ROOT=/tmp/vault npm run dev  # API on :5080 plus the Vite dev server
```

## Layout

| File | Responsibility |
| --- | --- |
| `index.mjs` | Server factory, request pipeline (auth, CSRF, rate limits, body limits) and handlers |
| `routes.mjs` | Route table: method, path, public / room access, body schema |
| `auth.mjs` | Owner account (scrypt), sessions, TOTP, CSRF, agent credentials |
| `mcp-remoto.mjs` | OAuth 2.1 authorization server and Streamable HTTP MCP endpoint |
| `vault.mjs`, `vault-*.mjs` | Reading, parsing, validation, formatting, mutations, tasks, ledger, Git history |
| `journal.mjs`, `history.mjs` | Write-ahead journal and per-note history |
| `finance*.mjs` | Finance domain: accounts, cards, cash-flow, idempotent operations, imports |
| `aprobaciones.mjs` | Approvals with idempotent receipts |
| `work-orders.mjs`, `user-requests.mjs`, `effects-executor.mjs` | Work orders, persistent questions, effects with external consequences |
| `shared-files.mjs` | Briefcase storage, quotas, expiry and trash |
| `lanzador.mjs` | Client for the agent runner |
| `change-feed.mjs` | SSE change notifications |
| `lib/durable-store.mjs` | Atomic JSON writes, JSON-lines append, serial queues |

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
approvals, work orders, briefcase limits, packaging and the remote MCP. Helpers
in `tests/helpers/` create synthetic vaults; tests never use real notes.
