# SecondBrain monorepo rules

These rules apply to every contributor, human or agent. Read the `AGENTS.md`
of each module you touch.

- Never commit secrets, personal notes, vault exports or operational state.
  Host-specific values belong in git-ignored files (`ops/lxc/lxc.env`,
  `.mcp.json`) or in GitHub environment variables.
- The vault lives outside this repository (`VAULT_ROOT`, its own Git remote).
  Do not create a local copy of it in the checkout.
- To read or change knowledge use the `secondbrain` MCP: start with
  `brain_context`, write full notes with the current hash, keep unknown YAML
  and links, re-read on conflict. Structured finance changes only through
  `brain_finance_operation`. Never store secrets or conversation transcripts.
- `service/` is the single writer (no SQL mirror); `mcp/` uses its API;
  `dashboard/` is the interface; `launcher/` runs agent CLIs in isolation;
  `ops/` packages and operates the system. CI/CD ships code, never knowledge.
- Language: the UI is Spanish by default with English in
  `dashboard/src/i18n/`; identifiers, comments and docs are English.
  New file names and identifiers must be English ([ADR 0007](docs/adr/0007-english-identifiers.md));
  HTTP routes, MCP tool names, env vars and stored data keep their names.
  `ops/tests/naming-convention.test.mjs` enforces it against
  `ops/naming-legacy.json`, which may only shrink.
- Commits follow Conventional Commits ([CONTRIBUTING](CONTRIBUTING.md)).
  Enable the hook with `git config core.hooksPath .githooks`.
- Commands from the root: `npm run setup`, `npm run dev`, `npm test`,
  `npm run test:api`, `npm run lint`, `npm run typecheck`, `npm run build`.
  Tests use synthetic temporary directories; never mutate a real vault to
  verify code.
- Architecture and limits: [docs/architecture](docs/architecture/README.md),
  [MCP tools](docs/mcp-tools.md), [lanzador](docs/modules/launcher.md),
  [deployment](docs/deployment.md).
