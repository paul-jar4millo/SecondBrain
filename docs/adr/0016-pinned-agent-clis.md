# 0016 · Agent CLIs are pinned and contract-tested in CI

- Status: accepted
- Date: 2026-11-21 (decided for phase 1.5, shipped in v0.5.0, #58)

## Context and problem statement

The launcher drives the official CLIs (Claude Code, Codex, Antigravity)
through their structured protocols (ADR 0004). CI uses fake CLIs, so it
cannot see when a real CLI changes. In v0.4.0 every Codex thread died at
start-up because Codex rejected a `-c` option that the fake accepted. Only the
manual end-to-end run found it (#53). The host also installed whatever version
was current, so CI and production could differ.

## Decision drivers

- A CLI update must be tested before it reaches the host.
- The host must run exactly the versions CI tested.
- No provider account or credential in CI.

## Considered options

1. Track the latest versions and rely on the manual end-to-end check.
2. Pin versions in a manifest and test the launcher's real arguments against
   them in CI, without an account.

## Decision outcome

Chosen option 2.

- `ops/agents/versions.json` and `ops/agents/package-lock.json` pin Claude
  and Codex by npm version and integrity hash, and Antigravity by archive URL
  and SHA-512.
- `ops/agents/install.mjs` installs exactly those on the host and switches a
  `current` link only after every binary reports its pinned version.
- `.github/workflows/agent-cli-contract.yml` installs the same versions with
  temporary homes and checks what the launcher generates: Codex startup
  config and app-server initialization, the Claude SDK MCP initialization and
  `--mcp-config`, and the ACP `initialize` request. It sends no prompt.
- Dependabot proposes updates, and the contract job tests them before merge.

### Consequences

- Good: the failure behind #53 is now caught in CI.
- Good: host and CI run the same binaries.
- Bad: updates are pull requests to review, not automatic.
- Bad: the contract test covers start-up and arguments, not model behavior;
  the live check (`ops/verify-runtime.mjs --live`) still runs after deploys.
