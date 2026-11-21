# 0013 · The MCP server is an adapter over the HTTP API

- Status: accepted
- Date: 2026-11-21 (records a choice made on 2026-11-10)

## Context and problem statement

AI clients (desktop tools on the owner's PC, agents inside threads, remote
clients) need the same capabilities as the dashboard: read and write notes,
run finance operations, use the briefcase, ask the owner questions. The
Model Context Protocol is the common interface for that. The MCP server could
read the vault itself or go through `service`.

## Decision drivers

- Keep one writer and one place that checks permissions (ADR 0001).
- Agents must not have filesystem access to the vault (ADR 0003).
- One credential model for every client: owner token, scoped agent
  credentials, OAuth clients.

## Considered options

1. An MCP server with direct read and write access to `VAULT_ROOT`.
2. MCP tools implemented inside `service`.
3. A separate `mcp` module that only calls the HTTP API, with thin
   transports.

## Decision outcome

Chosen option 3, with the remote transport mounted by the service.

- `mcp/index.mjs` registers the tools with the official SDK and calls
  `/api/v1` through `mcp/http.mjs`. It never opens vault files and imports no
  service code.
- Transports: stdio over SSH for desktop clients; the `brain` CLI
  (`mcp/brain-cli.mjs`) for agents inside threads, with a scoped `sbcap_`
  credential; and Streamable HTTP at `/mcp` for remote clients, mounted by
  `service/remote-mcp.mjs` behind OAuth 2.1
  ([ADR 0018](0018-authentication-in-the-service.md)).
- Every write carries the note's hash and every finance operation a
  `requestId`. A timeout is reported as an uncertain result, never as a
  failure.
- Tool names are a public contract and keep their names (ADR 0007).

### Consequences

- Good: permissions, journal, approvals and rate limits apply to every client
  in one place.
- Good: an agent's credential can be narrowed per thread and revoked when the
  thread closes.
- Bad: every tool call is an extra HTTP hop, which is fine for one owner.
- Bad: large files need streaming helpers (`files_download`, `files_upload`)
  so they never pass through the model's context.
