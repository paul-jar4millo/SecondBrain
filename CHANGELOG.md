# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/paul-jar4millo/SecondBrain/releases/tag/v0.1.0
