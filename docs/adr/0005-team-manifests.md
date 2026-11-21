# 0005 · Agent teams are bounded by an approved manifest

- Status: superseded by [ADR 0010](0010-threads-replace-sessions.md) (work orders removed; spending and process limits stay)
- Date: 2026-11-19

## Context and problem statement

A lead agent can delegate work to other agents (`equipo_encargar`). Without
limits a team could spawn more sessions, use more expensive models or write
over each other's files. The owner needs to approve the shape of a team once
and trust that it is respected.

## Decision drivers

- Spending and process limits that an agent cannot raise by itself.
- Parallel writers must not silently overwrite each other.
- The owner keeps the final say on integration.

## Considered options

1. Free-form delegation with global limits only.
2. A work order whose manifest (up to four member cards: engine, model,
   effort, role, tool profile) is frozen when approved and enforced by code.

## Decision outcome

Chosen option 2:

- Global limits: six active sessions, four active members per team, depth two.
  When no process slot is free, a member waits in a resource queue.
- With a manifest, `equipo_encargar` only accepts approved member cards;
  `requestId` makes delegation idempotent.
- Each member works in its own Git worktree (or a copy for folders without a
  repository). Deliverables are versioned with SHA-256.
- `equipo_integrar` (coordinator only) copies deliverables into the work
  order's workspace and returns conflicts — two writers on one path, or a
  destination changed since the base hash — without writing anything.
- Billed providers require a spending authorization from the owner's own
  session; an agent cannot grant it.

### Consequences

- Good: predictable cost and a clear audit trail of who produced what.
- Good: manual edits by the owner are never overwritten by an integration.
- Bad: ad-hoc help outside the manifest needs a new work order.
