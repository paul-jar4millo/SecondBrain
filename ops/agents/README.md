# Agent CLI pins

The launcher and CI use the same Linux x64 command-line tools. The provider
manifest identifies the exact Claude and Codex dependencies in the standalone
npm lockfile. Dependabot proposes updates to those packages and their
integrity hashes. Antigravity uses the Linux x64 archive and SHA-512 from
Google's official installer manifest.

On the host, run the following with Node.js on the system PATH.

```sh
node ops/agents/install.mjs
node ops/agents/install.mjs --check
```

The installer switches `/opt/sb-agente/cli/current` after all three binaries
report their pinned version. Each installation remains available by its
manifest digest. The launcher prepends `current/bin` to PATH and passes
`current/bin/claude` explicitly to the Claude Agent SDK. It must support
sending MCP configuration over stdin.

Use `--prefix` for a separate test installation. The CI check runs
`verify.mjs --prefix <directory>` with temporary homes and no operator
credentials. It exercises Codex startup config and app-server
initialization, Claude's SDK MCP initialization and `--mcp-config`, and
Antigravity's ACP initialize request. It sends no user prompt.
