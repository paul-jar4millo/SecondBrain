# mcp

- Keep the public server name `secondbrain` and its tool names.
- `index.mjs` and `brain-cli.mjs` call the HTTP API; never open or version vault
  files directly.
- Do not import service or dashboard code. Keep this module's own manifest
  and lockfile.
- `SB_BRAIN_URL` selects the API. The owner's MCP uses `DATA_DIR/agent-token`;
  agents receive a scoped credential through `SB_BRAIN_TOKEN_FILE`.
- Never print credentials or pass them as arguments. Keep permissions,
  revisions, finance `requestId`s and the "uncertain result" warning after a
  write timeout.
- `npm test` runs against an API with temporary fixtures, never real notes.
- Tool reference: [docs/mcp-tools.md](../docs/mcp-tools.md).
