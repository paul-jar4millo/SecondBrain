# 0009 · Agent operational state lives in SQLite

- Status: accepted
- Date: 2026-11-20

## Context and problem statement

The launcher keeps agent state in JSON files (`sesiones.json`, one folder per
conversation and session detail). Every change rewrites a whole file, the
service streams the full snapshot on each change, and nothing can be replayed
from a position. The new chat (threads, see
[ADR 0010](0010-threads-replace-sessions.md)) needs an append-only event log
with ordered sequence numbers, projections that can be rebuilt from that log,
and queries such as "open requests across all threads" for the inbox.

[ADR 0002](0002-no-sql-mirror.md) forbids a SQL mirror of the vault. Agent
operational state is not vault knowledge: it is never written to the vault
and it is not synchronised with Git.

## Decision drivers

- Resume a stream from a sequence number after a disconnect.
- One transaction per command: event append and projection update are atomic.
- No new native dependency and no extra daemon on the LXC.

## Considered options

1. Keep JSON files and add an append-only JSONL log per thread.
2. `node:sqlite` (built into Node ≥ 24) in WAL mode.
3. An external database (PostgreSQL) in another container.

## Decision outcome

Chosen option 2.

- The launcher owns `$SB_LANZADOR_DATA_DIR/threads.sqlite`; only
  `launcher/threads/store/db.ts` opens it and there is a single writer.
- Schema versions use `PRAGMA user_version`; migrations are idempotent.
- `events` is the source of truth (`thread_id + seq` primary key and a unique
  `global_seq`); `items`, `turns`, `requests` and the inbox view are
  projections rebuilt by replaying the log. Streaming deltas are not stored.
- The service stores push subscriptions and its outbox in its own
  `notifications.sqlite`; the Discord bot keeps a rebuildable `links.sqlite`.
- A nightly `VACUUM INTO` writes the backup copy.
- ADR 0002 applies only to the vault.

Spike (production LXC, Node 24.22.2, 2026-11-20): `DatabaseSync` opens WAL
databases and reads `user_version` without flags.

### Consequences

- Good: replay and resume are cheap; the inbox is a query.
- Good: projections can be rebuilt after a bug fix.
- Bad: `node:sqlite` is still marked experimental in Node 24; access stays
  behind one module so a replacement touches one file.
