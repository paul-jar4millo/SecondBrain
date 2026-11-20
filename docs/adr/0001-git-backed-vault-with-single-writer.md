# 0001 · Git-backed Markdown vault with a single writer

- Status: accepted
- Date: 2026-11-08

## Context and problem statement

The owner's knowledge (tasks, calendar, projects, finance, notes) must stay
readable without the app, editable from several clients (browser, phone,
desktop AI tools, autonomous agents) and recoverable after mistakes. Several
writers editing Markdown files directly would race and silently lose changes.

## Decision drivers

- Plain files the owner can open with any editor (Obsidian compatible).
- History and off-host copies without running a database server.
- Concurrent clients must never overwrite each other's edits.
- Agents must not get direct filesystem access to personal data.

## Considered options

1. Each client writes the files directly (shared folder, sync tool).
2. A database as the source of truth, exporting Markdown.
3. Markdown as the source of truth, one service as the only writer, Git for history.

## Decision outcome

Chosen option 3. `service` is the only process that writes the vault:

- Every write includes `expectedHash` (SHA-256 of the version read); a
  mismatch returns `409` and the client reconciles.
- Writes are serialized, journaled before the file is replaced (temporary file
  - atomic rename) and replayed after a crash.
- With `VAULT_GIT=on`, confirmed transactions are committed with
  isomorphic-git (no `git` binary in the request path) and a systemd timer
  pushes to a private remote every ten minutes with its own deploy key.
- Clients — dashboard, MCP adapter, `brain` CLI — use the HTTP API only.

### Consequences

- Good: the vault stays plain Markdown with unknown YAML fields preserved.
- Good: every change is attributable (journal + Git) and reversible.
- Bad: writes go through one process; throughput is bounded by it, which is
  acceptable for a single owner.
- Bad: recovering a note means reading an older version elsewhere and writing
  it back through the API — never `reset`/`checkout` on the live vault.
