# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.1
[0.1.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.0
