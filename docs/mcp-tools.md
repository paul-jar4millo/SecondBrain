# MCP tools

`mcp/index.mjs` implements a [Model Context Protocol](https://modelcontextprotocol.io)
server on top of the [HTTP API](api.md). It never touches the vault directly.
Tool descriptions are in Spanish (like the vault); `SB_OWNER_NAME` sets the
name they use for the owner.

## Transports

| Transport       | Where                                           | Used by                                                                           |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| stdio over SSH  | `node mcp/index.mjs` inside the container       | Desktop AI clients on the owner's PC (`.mcp.json`, `dashboard/ops/setup-mcp.ps1`) |
| `brain` CLI     | `mcp/brain-cli.mjs`                             | Isolated agent sessions, with a scoped token                                      |
| Streamable HTTP | `https://<host>/mcp` (`service/remote-mcp.mjs`) | Remote clients through OAuth 2.1                                                  |

Copy `.mcp.json.example` to `.mcp.json` (git-ignored) and set your SSH alias
and container id.

## Tools

### Vault

| Tool            | Purpose                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `brain_context` | Read the vault's rules and indexes. Call first.                                                       |
| `brain_list`    | List Markdown paths, filtered by folder or term                                                       |
| `brain_search`  | Full-text search; paths and snippets, at most 50 results                                              |
| `brain_read`    | Read a full note and its revision hash                                                                |
| `brain_write`   | Create or replace a full note with `expectedHash` (`null` creates). Unknown YAML fields are preserved |

### Finance

| Tool                      | Purpose                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `brain_finance`           | Read-only overview derived from the vault                                                                       |
| `brain_finance_operation` | Validated structured operation with a stable `requestId`. From agent sessions it waits for the owner's approval |

### Briefcase

A shared folder outside the vault: `para-agentes` (owner → agents) and
`de-agentes` (agents → owner). Limits: 100 MB per file, 2 GB total, 30-day
expiry unless pinned, 7-day trash. Attachments are untrusted data.

| Tool             | Purpose                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `files_list`     | List both folders                                                              |
| `files_get`      | Read a file up to 8 MB into the context (text, or base64 chunks with `offset`) |
| `files_download` | Save a file to the session's disk, verifying SHA-256 (stdio and CLI only)      |
| `files_upload`   | Stream a file from disk to `de-agentes`, up to 100 MB (stdio and CLI only)     |
| `files_put`      | Create a small file from the call's content (~8 MB)                            |
| `files_trash`    | Trash one of your own deliverables                                             |

### Threads

| Tool              | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `thread_ask_user` | Ask the owner from inside a thread; the question shows inline in its view |
| `thread_report_review` | Report the review stage's verdict; changes go back to the implementer, up to the flow's round limit |
| `thread_handoff` | Pass the thread to another stage of its flow; it happens when the turn ends, with a brief the system builds |

### Questions to the owner

| Tool                          | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `usuario_preguntar`           | Create a persistent question; returns its id without blocking |
| `usuario_consultar_respuesta` | Check a question's state                                      |
| `usuario_esperar_respuesta`   | Wait in safe intervals for an answer or closure               |

## Writing rules for agents

1. Call `brain_context` first; discover with `brain_list` / `brain_search`.
2. Read the whole note with `brain_read` and keep its hash.
3. Write the full content with `brain_write` and that hash.
4. On a conflict, re-read and reconcile; keep foreign YAML and links.
5. Never store secrets or conversation transcripts.
6. Never edit the finance data note by hand; use `brain_finance_operation`.
   A timeout does not prove an operation failed — check before repeating
   with the same `requestId`.

## Remote access

The HTTP transport uses OAuth 2.1 with dynamic client registration, PKCE S256
and single-use codes. Metadata is served at
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`. Redirects must be HTTPS or
localhost. Codes last 10 minutes, access tokens one hour and rotating refresh
tokens 60 days. Clients can be revoked in Settings or with
`POST /oauth/revoke`. Each client is identified in the journal and
rate-limited.

Reverse proxies must forward `/mcp`, `/oauth/*` and `/.well-known/oauth-*`
besides `/api/`.
