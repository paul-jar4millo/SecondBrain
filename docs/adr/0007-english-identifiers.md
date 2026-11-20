# 0007 · English identifiers, Spanish product

- Status: accepted
- Date: 2026-11-20

## Context and problem statement

The code mixed Spanish and English names (`crearEjecutor` next to
`createWorkOrderStore`, `sesiones.mjs` next to `work-orders.mjs`). Agents and
people had to guess which language a new name should use, and the same idea
had two names.

## Considered options

1. Keep the mix and decide case by case.
2. Spanish everywhere.
3. English for code; Spanish only where users see it.

## Decision outcome

Chosen option 3.

- Identifiers, file names and folders of new code are in English.
- These keep their current names because they are contracts: HTTP routes
  (`/api/v1/agentes/...`), MCP tool names (`brain_*`, `equipo_*`),
  environment variables, vault formats, and stored data files.
- Text shown to users and test titles stay in Spanish; the product is in
  Spanish.
- `ops/tests/naming-convention.test.mjs` fails when a file name or an
  exported backend identifier contains a common Spanish word
  (`ops/naming.mjs`). Existing names are listed in `ops/naming-legacy.json`;
  the list can only shrink, and the test fails when an entry no longer exists.

The backend module files were renamed in the same change (for example
`ejecucion.mjs` → `executor.mjs`, `sesiones.mjs` → `sessions.mjs`,
`service/sala.mjs` → `service/room.mjs`). Exported identifiers, the dashboard
`sala`/`mundo` features and the `lanzador/` folder are renamed later, each in
its own change.

### Consequences

- Good: one language per layer; the check stops new mixed names.
- Bad: the rename touches many imports at once, and the legacy list stays
  until the remaining renames land.
