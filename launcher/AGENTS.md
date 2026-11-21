# launcher

- Runs official agent CLIs for threads as the unprivileged user `sb-agente`,
  behind a loopback HTTP API with a control token. The service never runs a
  model ([ADR 0003](../docs/adr/0003-isolated-agent-sessions.md)).
- Talk to providers only through the controllers in `lib/providers/`
  (Codex app-server, Claude Agent SDK, ACP); never scrape a terminal
  ([ADR 0004](../docs/adr/0004-provider-adapters.md)).
- `threads/store/db.ts` is the only code that opens `threads.sqlite`. The
  `events` log is the source of truth; projections must be rebuildable by
  replaying it ([ADR 0009](../docs/adr/0009-operational-state-in-sqlite.md)).
- New code is native TypeScript with erasable syntax only; shared shapes come
  from `../contracts/src/index.ts`
  ([ADR 0011](../docs/adr/0011-native-typescript-and-contracts.md)).
- Never read `VAULT_ROOT` or `DATA_DIR`. Agents reach the vault through the
  `brain` CLI with their thread's `sbcap_` credential. Keep supervisor tokens
  out of the agent's environment (`threads/child-env.mjs`).
- Do not import service or dashboard code.
- CLI flags must work with the pinned versions in `ops/agents/versions.json`;
  the `agent-cli-contract` workflow checks them
  ([ADR 0016](../docs/adr/0016-pinned-agent-clis.md)).
- Tests use fake CLIs, synthetic repositories and temporary SQLite files:
  `npm --prefix launcher test`. They never call a provider.
- Module guide: [docs/modules/launcher.md](../docs/modules/launcher.md).
