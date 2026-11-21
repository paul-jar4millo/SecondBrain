# 0017 · English host layout through a reversible migration

- Status: accepted
- Date: 2026-11-21 (shipped in v0.5.x, #58; aliases retired in v0.6.0, #68)
- Completes: [ADR 0007](0007-english-identifiers.md), which kept the release
  and host names in Spanish for compatibility.

## Context and problem statement

After ADR 0007 the code was in English, but the host still used Spanish
paths, units, scripts, HTTP routes and environment variables (`lanzador`,
`/agentes/*`, `SB_LANZADOR_*`, `secondbrain-lanzador`). Renaming them on a
live host risks losing agent state, CLI logins and worktree registrations.

## Decision drivers

- One language for every name a developer or operator reads.
- No lost data or logins; the change must be rehearsable and reversible.
- A rollback to the previous release must keep working.

## Considered options

1. Keep the Spanish host names.
2. Rename everything in one release with a manual runbook.
3. A compatibility release that understands both names, a scripted and
   idempotent migration, then a release that removes the aliases.

## Decision outcome

Chosen option 3.

- v0.5.x served the old HTTP routes as aliases with a `Deprecation` header
  and shipped `ops/migration/migrate-host-layout.mjs`: a read-only plan by
  default, `--apply` under the deploy lock, a root-only journal to resume an
  interrupted run, `--rollback`, and SQLite path rewrites that keep event
  sequences.
- The marker `/etc/secondbrain/english-layout` tells later deploys which
  layout to use.
- v0.6.0 removed the aliases. `--retire-aliases` removes only symlinks that
  point at their English successor.
- `ops/naming.mjs` and `ops/operational-naming-legacy.json` extend the naming
  check to routes, `SB_*` variables, `ops/` file names and systemd units.
- The Unix account `sb-agente` keeps its name: renaming it would break CLI
  logins, file ownership and UID-based firewall rules.

### Consequences

- Good: one naming scheme on every layer, and CI stops new Spanish names.
- Good: the migration was rehearsed on a disposable container before the
  production one ([host layout migration](../host-layout-migration.md)).
- Bad: the `sb-agente` account and a few stored names remain as documented
  exceptions.
