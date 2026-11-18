# 0003 · Agents run in isolated sessions under a separate user

- Status: accepted
- Date: 2026-11-10

## Context and problem statement

Agent CLIs (Claude Code, Codex, Antigravity, DeepSeek through Claude Code) run
with broad permissions inside their working directory and have internet
access. They must be able to work on repositories and read the vault through
tools, but must not read personal data, credentials of other providers or
reach other machines on the local network.

## Decision drivers

- The HTTP service must never execute model code.
- A misbehaving agent must not affect the vault or other sessions.
- Use only official clients and never extract their credentials.

## Considered options

1. Run agents inside the service process (SDK calls).
2. A container per session.
3. A dedicated runner process (`lanzador`) under a separate Unix user, with
   systemd resource limits and an nftables policy.

## Decision outcome

Chosen option 3:

- `lanzador` runs as `sb-agente`, without access to `VAULT_ROOT` or
  `DATA_DIR`. Agents reach the vault through the `brain` CLI with a scoped,
  revocable token ("room credential") that cannot manage authentication or
  edit the vault's rule files.
- Each provider gets an allow-listed environment; desktop connectors are
  disabled and the MCP configuration is passed explicitly (`--strict-mcp-config`).
- systemd caps memory and tasks for all sessions together; `OOMPolicy=continue`
  kills only the offending process.
- nftables (inside the container's network namespace) rejects private
  address ranges for the agent user, except an optional Wake-on-LAN target.
- The service talks to `lanzador` over loopback with a bearer token; hooks use
  a separate credential.
- Before each turn the working tree is saved as a Git checkpoint in private
  refs, so file changes can be reverted.

### Consequences

- Good: a compromised session is contained to one user and its workspaces.
- Good: sessions survive service deployments; the runner restarts only when
  its own code changes.
- Bad: browser verification and full builds do not fit the agent memory
  budget and run in CI instead.
