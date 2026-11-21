# 0012 · The vault lives in its own private repository

- Status: accepted
- Date: 2026-11-21 (records a choice made on 2026-11-08, see
  [ADR 0001](0001-git-backed-vault-with-single-writer.md))

## Context and problem statement

The application code is public: it is open source under MIT. The vault holds
the owner's notes, tasks and finances. Both are Git repositories and agents
touch both. They must never mix, and a mistake in one (a bad deploy, a leaked
file) must not reach the other.

## Decision drivers

- Personal data must never appear in a public repository, its history, its
  CI logs or its release artifacts.
- Code and knowledge change at different speeds and through different paths:
  code through pull requests and tags, notes many times a day through the API.
- Recovering a note must not depend on the state of the code, and the other
  way around.

## Considered options

1. One repository with the vault in a git-ignored folder.
2. One repository with the vault as a submodule.
3. Two independent repositories, public code and private vault, connected
   only by `VAULT_ROOT` at run time.

## Decision outcome

Chosen option 3.

- The vault is an ordinary folder at `VAULT_ROOT` on the host, with its own
  private remote and its own deploy key. A systemd timer
  (`ops/secondbrain-vault-push.timer`) pushes it every ten minutes. The code
  repository has no reference to it.
- `service` is the only writer (ADR 0001) and commits confirmed transactions
  with isomorphic-git. Nobody runs `pull`, `reset` or `checkout` on the live
  vault.
- CI/CD ships code only. Release packages contain no vault, credentials or
  operational state (`ops/package-release.mjs`).
- Tests and the demo use synthetic vaults created in temporary folders.
- Host values (`ops/lxc/lxc.env`, `.mcp.json`) are git-ignored; deployment
  values live in GitHub environment variables.

### Consequences

- Good: publishing the code cannot publish a note, and restoring the vault
  never touches releases.
- Good: the vault stays usable with any Git client or with Obsidian.
- Bad: two backups to watch (the vault remote, and restic for `DATA_DIR`).
- Bad: a fresh install needs the vault repository and its deploy key set up
  by hand.
