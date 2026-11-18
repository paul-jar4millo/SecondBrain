# mcp

An MCP server and CLI that give AI clients the same capabilities as the
dashboard, through the HTTP API. The tool list is in [MCP tools](../mcp-tools.md).

```sh
npm --prefix mcp test
SB_BRAIN_URL=http://127.0.0.1:5080/api/v1 node mcp/index.mjs   # stdio server
node mcp/brain-cli.mjs brain_read '{"path":"Home.md"}'          # one-shot CLI
```

| File | Responsibility |
| --- | --- |
| `index.mjs` | `createBrainMcp()` registers tools with the official SDK; stdio entry point |
| `http.mjs` | API client: bearer token, timeouts, chunked waits, streaming uploads and downloads |
| `brain-cli.mjs` | Runs a single tool call from a shell; used by isolated agent sessions |

Design choices:

- Long waits (`equipo_esperar`, `usuario_esperar_respuesta`) are split into
  intervals shorter than HTTP timeouts.
- `files_download` and `files_upload` stream to and from disk with SHA-256
  checks so large files never pass through the model's context; they exist
  only where the caller has a local disk (stdio and CLI).
- `ownerLabel()` sanitizes `SB_OWNER_NAME` (60 characters max) before it is
  used in instructions and tool descriptions.
