# service

- Node.js 24 HTTP API: one writer instance per vault, no SQL mirror.
- Keep hash revisions, the write queue, journal, recovery, history and unknown
  YAML fields.
- Do not import dashboard or MCP code.
- The HTTP process never runs agent CLIs; that belongs to the isolated `lanzador`.
- With `VAULT_GIT=on`, require an initialized vault repository. Commit
  confirmed transactions with isomorphic-git; a Git failure never reverts a
  saved note. Pushing is done by a systemd timer.
- Never `pull`, `checkout` or `reset` the live vault. Recover notes through the
  API or MCP with the current hash.
- Tests use synthetic temporary directories: `npm run test:api` from the root
  or `npm test` here.
- Module guide: [docs/modules/service.md](../docs/modules/service.md).
