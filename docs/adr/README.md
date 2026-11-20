# Architecture decision records

Decisions are written in the [MADR](https://adr.github.io/madr/) format. A
record is never rewritten after it is accepted; a later record supersedes it.

| ADR                                                 | Title                                                             | Status   |
| --------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](0001-git-backed-vault-with-single-writer.md) | Git-backed Markdown vault with a single writer                    | Accepted |
| [0002](0002-no-sql-mirror.md)                       | No SQL mirror of the vault                                        | Accepted |
| [0003](0003-isolated-agent-sessions.md)             | Agents run in isolated sessions under a separate user             | Accepted |
| [0004](0004-provider-adapters.md)                   | Own provider adapters instead of embedding a third-party agent UI | Accepted |
| [0005](0005-team-manifests.md)                      | Agent teams are bounded by an approved manifest                   | Accepted |
| [0006](0006-conventional-commits.md)                | Conventional Commits enforced locally and in CI                   | Accepted |
| [0007](0007-english-identifiers.md)                 | English identifiers, Spanish product                              | Accepted |
| [0008](0008-npm-workspaces.md)                      | npm workspaces with per-module release lockfiles                  | Accepted |
| [0009](0009-operational-state-in-sqlite.md)         | Agent operational state lives in SQLite                           | Accepted |
| [0010](0010-threads-replace-sessions.md)            | Threads replace sessions, PTY terminals and `sb-hilo`             | Accepted |
| [0011](0011-native-typescript-and-contracts.md)     | Native TypeScript for new backend code and a shared `contracts`   | Accepted |
