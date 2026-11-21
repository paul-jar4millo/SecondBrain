# 0018 · Authentication lives in the service

- Status: accepted
- Date: 2026-11-21 (records a choice made on 2026-11-09)

## Context and problem statement

SecondBrain has one human user and several kinds of machine clients: the
owner's desktop MCP, agents inside threads, remote MCP clients and, later, a
Discord bot. Each needs a different scope. Authentication could sit in front
of the app (an SSO proxy such as Authelia or Cloudflare Access) or inside
`service`.

## Decision drivers

- One owner: running and securing another identity service is not worth it.
- Agent credentials must be scoped to routes and to one thread, and revoked
  when the thread closes, which needs knowledge only the service has.
- Remote MCP clients expect an OAuth 2.1 authorization server.

## Considered options

1. An SSO in the reverse proxy, with the app trusting a header.
2. Authentication in `service` (`service/auth.mjs`, `service/remote-mcp.mjs`).

## Decision outcome

Chosen option 2.

- Owner: scrypt password hash, optional TOTP, a session cookie with CSRF
  protection, and rate limits. Production refuses to start without
  authentication.
- Agents: `sbcap_` capability tokens, hashed at rest, bound to a thread id
  and a route allow-list. They cannot manage authentication or write the
  vault's rule files.
- Remote MCP: OAuth 2.1 with dynamic client registration, PKCE S256,
  single-use codes, rotating refresh tokens and per-client revocation.

### Consequences

- Good: every request, human or agent, goes through the same route policy
  table (`service/routes.mjs`), which `route-smoke.test.mjs` exercises.
- Bad: the project maintains security-sensitive code that an SSO product
  would otherwise provide; it is covered by tests and reviewed on change.

**Pending (owner to confirm):** whether reverse-proxy SSO was also rejected
for reasons other than running one more service.
