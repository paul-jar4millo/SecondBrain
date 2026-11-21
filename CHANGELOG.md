# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.5.2] - 2026-11-21

### Fixed

- The v0.5.1 deploy rolled back because the native launcher imported
  service code that the native package no longer ships. The shared modules
  live in `contracts/`, and a test fails on any import that does not
  resolve inside the native package.

## [0.5.1] - 2026-11-21

### Fixed

- The v0.5.0 deploy stopped at the container smoke test, which ran the
  image as a user that could not write its data folder. The smoke now runs
  as the data owner, as production does, and CI builds and tests the image
  on every pull request.

## [0.5.0] - 2026-11-21

### Changed

- The service, MCP and dashboard run as one OCI image, published to GHCR
  with an SBOM and deployed by digest through a Podman Quadlet unit. The
  launcher stays native.
- Each deploy applies the host configuration, units and firewall, then runs
  `ops/deploy/verify.sh` from the release and rolls back if it fails.
- The agent CLIs (Claude, Codex, Antigravity) are pinned in `ops/agents/`.
  CI installs those versions and checks the launcher's real launch options.
- Service and launcher routes, JSON keys and `SB_*` variables use English
  names. The Spanish names still work in this release, with a `Deprecation`
  header on the routes.
- A host migration script moves the server layout to English names. It shows
  the plan by default and supports `--apply` and `--rollback`.

### Removed

- The launcher compatibility layer and its version markers.

## [0.4.2] - 2026-11-20

### Changed

- The refuge, projects and settings use the Threads projection. Tasks,
  projects and finance open the new thread form with the relevant context.
  Financial approvals are available in Finance.
- Browser verification covers desktop and mobile thread workflows. The
  live smoke test checks that Codex receives a steer during an active turn.

### Removed

- The session-era Equipo dashboard and the empty session-list API shim.

## [0.4.1] - 2026-11-20

### Fixed

- Codex threads no longer die at startup with "Proveedor desconectado". The
  launcher named the `claude.ai` connector to Codex, which reads the dot as
  nesting and rejected the resulting `claude` server.
- The provider's stderr goes to the launcher's journal.

## [0.4.0] - 2026-11-20

Agent work moves from sessions to threads (ADR 0009–0011). The session-era
chat, teams and work orders are removed.

### Added

- Threads: one task per thread, with its own worktree and `sb/…` branch (or a
  scratch folder), an SQLite event log in the launcher (`node:sqlite`) and a
  resumable SSE stream. Send, steer, queue and stop; questions, approvals and
  MCP forms answered inline; diff per thread and per turn; close by pull
  request, local merge or discard.
- `contracts/`: shared Zod schemas in native TypeScript.
- Service: `/api/v1/threads…` and `/bandeja`, a capability per thread, and
  the MCP tool `thread_ask_user`.
- Dashboard: the Threads tool (`/threads`), desktop and mobile.
- `ops/verify-runtime.mjs`: opt-in end-to-end check with a real agent.

### Removed

- Launcher sessions, terminal harness, hooks, teams, checkpoints, the
  `sb-hilo` CLI and the `@xterm` dependencies.
- Service routes `/agentes/sesiones/*` (the list answers `[]`),
  `/agentes/conversacion/*`, `/agentes/terminal/*`, `/equipo/*` and
  `/encargos*`; MCP tools `equipo_*`.

### Changed

- The morning summary opens a scratch thread with `POST /threads`.
- The launcher needs only the control credential (`SB_HOOK_HASH_FILE` is
  gone). After deploying, remove the session data on the host:
  `sesiones.json`, `sesiones.json.d/`, `indices-checkpoint/`, `links/`,
  `/usr/local/bin/sb-hilo` and the hook token.
- The legacy Equipo panel stays until the dashboard cleanup and shows no
  sessions.

## [0.3.1] - 2026-11-20

### Fixed

- Releases ship `lanzador/registro-version.mjs` again. The compatibility
  helper installed on hosts before v0.2.0 reads that file; without it the
  host kept the v0.1.2 launcher after every deploy.

## [0.3.0] - 2026-11-20

Internal refactor with no change to HTTP routes, MCP tools, environment
variables, the vault format, the release layout or user-facing text.

### Changed

- npm workspaces (ADR 0008): `package-lock.json` at the root is the only
  lockfile and `npm run setup` is a single `npm ci`. The release still ships
  one lockfile per module, cut from the root lockfile by
  `ops/release-lock.mjs`, so hosts and the deploy helper need no change.
- `overrides` (katex, minimatch) moved to the root `package.json`.
- The dashboard source is fully TypeScript: the refuge scene is split into
  `room-*.ts` modules, the world panel is `panel.ts`, and `allowJs` is gone.
- `launcher`: provider conversations are split into `launcher/conversation/`.
- Internal local variables, parameters and functions are renamed to English;
  data keys, log fields and cross-module method names keep their names.
- CI runs the browser suites weekly and opens an issue when they fail.
- Dependencies: transitive patch and minor updates from the workspace
  lockfile (hono, jose, @anthropic-ai/sdk, among others).

### Fixed

- `launcher/tool-catalog.mjs` finds the Claude Agent SDK wherever npm
  installs it.

## [0.2.0] - 2026-11-20

Internal refactor with no change to HTTP routes, MCP tools, environment
variables, the vault format or user-facing text.

### Changed

- Backend type checking: every `service`, `mcp` and `launcher` module is
  checked with `strict` TypeScript through JSDoc.
- `service`: `createApplication()` is split into `service/http/` (shared
  context, middleware, static files and one route module per domain); a test
  fails if a route policy has no handler or the reverse.
- `launcher`: the executor is split into `launcher/execution/` modules with
  explicit dependencies; the provider contract and server tests are split by
  topic.
- Names are English (ADR 0007): the `lanzador/` folder is now `launcher/`,
  backend and dashboard modules and exports are renamed (for example
  `crearEjecutor` → `createExecutor`, `features/sala` → `features/room`),
  and `ops/tests/naming-convention.test.mjs` blocks new Spanish names. The
  release package keeps `lanzador/` and `ops/lanzador/`, so hosts need no
  change.
- The Claude status line script is `usage-line.mjs`; settings that still use
  `uso-linea.mjs` are recognised and rewritten.
- Coverage floors per module in `ops/coverage.mjs`.
- Dependencies: vitest 5 with its coverage plugin, lucide-react 1.74.

### Fixed

- Release packaging copies the new `http/` and `execution/` subfolders.
- `dashboard/ops/render-agent-portraits.mjs` imports the character specs
  under their real name again.

## [0.1.2] - 2026-11-19

### Added

- `dashboard`: a failed, overdue or unreadable off-host backup appears in the
  reminders panel, read from `maintenance.backup` in `/api/v1/health`.

### Fixed

- `lanzador`: a message sent just as a turn ends is queued and delivered in the
  next turn instead of being accepted and never sent; a message queued after
  the session went idle starts that turn too.
- `service`: a work order keeps recording a follow-up turn started by a message
  sent during the previous one, including its artifacts.
- `lanzador`: an interactive session attaches its output and exit listeners
  before its first await, so early output is no longer lost from the screen and
  a fast exit can no longer leave the session working forever.
- Tests: the artifact end-to-end test reproduces the follow-up race on purpose
  and two terminal tests no longer depend on timing.

### Changed

- Dependencies: minor and patch updates across modules (this fixes the
  `minimatch` advisory), GitHub Actions to their current majors,
  `react-markdown` 10 and `lucide-react` 1. Dependabot updates `vitest` and
  its plugins together and holds back TypeScript 7 and `@types/node` majors.
- Repository: `main` accepts changes only through pull requests with the
  `verify`, `commits` and `audit` checks passing.

## [0.1.1] - 2026-11-19

### Fixed

- `service`: `/api/v1/health` reports the version from `service/package.json`
  instead of a hard-coded `0.2.0`; all modules are aligned at 0.1.1.
- `lanzador`: the session-registry marker is again a single export line, so
  deployment helpers installed on hosts recognize it and restart the runner
  after a release. The compatibility checker now also accepts leading line
  comments, and a test guards the marker against both formats.
- `ops`: the container capture used by off-host backups no longer fails once
  two local captures exist (`vzdump --remove 1` with `keep-last=2`).

## [0.1.0] - 2026-11-19

First public release.

### Added

- `service`: HTTP API and single vault writer with hash revisions, journal,
  recovery, history and isomorphic-git commits; password + TOTP auth; OAuth 2.1
  for remote MCP; finance ledger with idempotent operations; approvals with
  receipts; work orders, persistent questions and effects; briefcase.
- `mcp`: MCP server and `brain` CLI with vault, finance, briefcase, team and
  question tools; streaming uploads and downloads.
- `lanzador`: isolated agent runner with structured adapters for Codex
  app-server, the Claude Agent SDK and ACP; checkpoints, diffs and pull
  requests; teams bounded by manifests; `sb-hilo` terminal client.
- `dashboard`: React 19 PWA with the 3D refuge, projects, tasks, finance,
  briefcase, team conversations and settings; offline outbox; Spanish and
  English; static demo for GitHub Pages.
- `ops`: release packaging, Proxmox VE container provisioning, systemd units,
  nftables policy, restic backups, failure alerts and a deployment helper
  with health checks and rollback.
- CI with lint, format, type checks, ShellCheck, tests with coverage,
  Playwright suites and dependency audit; tag-driven deployment with manual
  approval; Pages demo.
- Documentation: architecture (C4), ADRs, module guides, API and MCP
  references, deployment, operations and CI/CD.

[0.5.2]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.5.2
[0.5.1]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.5.1
[0.5.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.5.0
[0.4.2]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.4.2
[0.4.1]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.4.1
[0.4.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.4.0
[0.3.1]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.3.1
[0.3.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.3.0
[0.2.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.2.0
[0.1.2]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.2
[0.1.1]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.1
[0.1.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.0
