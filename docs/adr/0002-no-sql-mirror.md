# 0002 · No SQL mirror of the vault

- Status: accepted
- Date: 2026-11-08

## Context and problem statement

Views such as tasks by date, project dashboards or the finance overview need
indexed data. A common answer is to mirror the Markdown into SQLite or
PostgreSQL and query that.

## Decision drivers

- One source of truth: two stores drift, and the vault is edited outside the app.
- Small data set (thousands of notes, not millions).
- Simple operations: no migrations or database backups on a home server.

## Considered options

1. SQLite mirror updated on every write and on file changes.
2. In-memory indexes rebuilt from the Markdown, with derived values computed on read.

## Decision outcome

Chosen option 2. `service` parses the vault into in-memory indexes (items,
tasks, ledger) and computes derived values — utilization, cash-flow margins,
reminders — on every read. Nothing derived is persisted. The browser keeps its
own offline copy in IndexedDB (Dexie) with an outbox of pending mutations, which
is a cache, not a second source of truth.

### Consequences

- Good: no schema migrations; the files are always the truth.
- Good: backups are file backups (vault Git + restic for `DATA_DIR`).
- Bad: start-up parses the whole vault; benchmarks
  (`dashboard/ops/benchmark-vault.mjs`) keep this within budget for the
  expected size.
- Bad: complex cross-note queries are code, not SQL.
