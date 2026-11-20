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
  exported identifier (backend or dashboard) contains a common Spanish word
  (`ops/naming.mjs`). Existing names are listed in `ops/naming-legacy.json`;
  the list can only shrink, and the test fails when an entry no longer exists.

The renaming landed in three changes: backend module files (for example
`ejecucion.mjs` → `executor.mjs`), then exported identifiers and the
dashboard `sala`/`mundo` features (→ `room`/`world`), and finally the
`lanzador/` folder → `launcher/` (and `ops/lanzador` → `ops/launcher`).
The legacy list is empty.

The release package keeps the launcher in `lanzador/` and its host files in
`ops/lanzador/` (`ops/package-release.mjs`, `RELEASE_MODULES`): systemd
units, `sb-hilo`, remote hooks and the deploy helper installed on the hosts
use those paths. Moving them needs a host migration and is a separate decision.

### Consequences

- Good: one language per layer; the check stops new mixed names.
- Bad: the rename touched many imports at once, and the release layout
  still uses `lanzador/` for host compatibility.
