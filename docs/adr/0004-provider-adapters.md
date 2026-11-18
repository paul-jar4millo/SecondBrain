# 0004 · Own provider adapters instead of embedding a third-party agent UI

- Status: accepted
- Date: 2026-11-17

## Context and problem statement

Early sessions drove each CLI through a pseudo-terminal and scraped the
screen. That was fragile: questions, permissions and tool calls had to be
guessed from terminal output. Each provider now offers a structured protocol
(Codex app-server, the Claude Agent SDK, the Agent Client Protocol), and open
projects such as T3 Code already integrate several of them.

## Decision drivers

- Structured messages, tool calls and questions instead of screen scraping.
- Keep authentication, permissions and approvals in this system.
- Avoid forking or vendoring a large application.

## Considered options

1. Embed T3 Code as a component or run it as a parallel service.
2. Write own adapters in `lanzador/`, using T3 Code only as a protocol reference.

## Decision outcome

Chosen option 2. `lanzador/provider-adapters.mjs` defines the capability
contract and `lanzador/lib/providers/` holds one controller per protocol:
`codex.mjs` (app-server JSON-RPC), `claude.mjs` (Claude Agent SDK, also used
for DeepSeek with separate configuration) and `acp.mjs` (Antigravity over ACP).
Conversations are persisted as normalized items by
`provider-conversations.mjs`; the dashboard renders only those items.

T3 Code (MIT) was studied for its provider boundary; no code was copied.

### Consequences

- Good: questions and permissions become persistent, answerable cards with
  idempotent responses; elicitation forms are validated against their schema.
- Good: the UI is independent of each CLI's terminal.
- Bad: each protocol change needs adapter work and tests with fake CLIs.
