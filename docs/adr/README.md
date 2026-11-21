# Architecture decision records

Decisions are written in the [MADR](https://adr.github.io/madr/) format:
context, drivers, options considered, decision and consequences. A record is
not rewritten after it is accepted; a later record supersedes or completes
it, and only its status line changes.

## By topic

| Topic                | Records                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge and data   | [0001](0001-git-backed-vault-with-single-writer.md), [0002](0002-no-sql-mirror.md), [0012](0012-vault-in-its-own-repository.md), [0009](0009-operational-state-in-sqlite.md) |
| Interfaces           | [0013](0013-mcp-as-an-api-adapter.md), [0018](0018-authentication-in-the-service.md), [0011](0011-native-typescript-and-contracts.md)                                        |
| Agents               | [0003](0003-isolated-agent-sessions.md), [0004](0004-provider-adapters.md), [0010](0010-threads-replace-sessions.md), [0016](0016-pinned-agent-clis.md)                      |
| Delivery and hosting | [0014](0014-container-service-native-launcher.md), [0015](0015-tag-gated-deployment.md), [0008](0008-npm-workspaces.md)                                                      |
| Conventions          | [0006](0006-conventional-commits.md), [0007](0007-english-identifiers.md), [0017](0017-english-host-layout.md)                                                               |

## All records

| ADR                                                 | Title                                                                     | Status                          |
| --------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| [0001](0001-git-backed-vault-with-single-writer.md) | Git-backed Markdown vault with a single writer                            | Accepted                        |
| [0002](0002-no-sql-mirror.md)                       | No SQL mirror of the vault                                                | Accepted (vault only, see 0009) |
| [0003](0003-isolated-agent-sessions.md)             | Agents run in isolated sessions under a separate user                     | Accepted; sessions → 0010       |
| [0004](0004-provider-adapters.md)                   | Own provider adapters instead of embedding a third-party agent UI         | Accepted                        |
| [0005](0005-team-manifests.md)                      | Agent teams are bounded by an approved manifest                           | Superseded by 0010              |
| [0006](0006-conventional-commits.md)                | Conventional Commits enforced locally and in CI                           | Accepted                        |
| [0007](0007-english-identifiers.md)                 | English identifiers, Spanish product                                      | Accepted; completed by 0017     |
| [0008](0008-npm-workspaces.md)                      | npm workspaces with per-module release lockfiles                          | Accepted; amended by 0014       |
| [0009](0009-operational-state-in-sqlite.md)         | Agent operational state lives in SQLite                                   | Accepted                        |
| [0010](0010-threads-replace-sessions.md)            | Threads replace sessions, PTY terminals and `sb-hilo`                     | Accepted                        |
| [0011](0011-native-typescript-and-contracts.md)     | Native TypeScript for new backend code and a shared `contracts`           | Accepted                        |
| [0012](0012-vault-in-its-own-repository.md)         | The vault lives in its own private repository                             | Accepted                        |
| [0013](0013-mcp-as-an-api-adapter.md)               | The MCP server is an adapter over the HTTP API                            | Accepted                        |
| [0014](0014-container-service-native-launcher.md)   | Self-hosted LXC: the service runs as an OCI image, the launcher is native | Accepted                        |
| [0015](0015-tag-gated-deployment.md)                | Deploy only from version tags, with approval, through an outbound runner  | Accepted                        |
| [0016](0016-pinned-agent-clis.md)                   | Agent CLIs are pinned and contract-tested in CI                           | Accepted                        |
| [0017](0017-english-host-layout.md)                 | English host layout through a reversible migration                        | Accepted                        |
| [0018](0018-authentication-in-the-service.md)       | Authentication lives in the service                                       | Accepted (one point pending)    |

## Not yet recorded

These choices are visible in the code, but their reasoning has not been
written down yet. They are listed here instead of being guessed:

- **Node.js for the backend** rather than another runtime. The code shows one
  language from the dashboard to the launcher and shared Zod schemas
  (ADR 0011); the original motivation is pending.
- **Offline-first PWA** (IndexedDB cache with an outbox of mutations, see
  [dashboard](../modules/dashboard.md)). Pending.
- **ADR 0018:** whether reverse-proxy SSO was rejected for further reasons.
