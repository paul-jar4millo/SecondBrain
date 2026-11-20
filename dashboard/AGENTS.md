# dashboard

- React 19 + Three.js PWA. UI strings go through `src/i18n/` (Spanish default,
  English); code and docs in English.
- Use the HTTP API only; never import service or MCP code into `src/`.
  Markdown is the source of truth; no SQL mirror.
- Keep hash revisions, unknown YAML fields and authenticated access. Tests use
  synthetic data only.
- The blue refuge is the full-screen main view: exactly four base agents, a
  persistent scene, a game-like HUD and clear tools over it ([DESIGN](../DESIGN.md)).
- The scene is generated in Blender by `ops/room-refuge.py`; the runtime is
  `src/features/room/room-world.js`.
- The refuge observes and approves real sessions; it never invents work,
  conversations or deliverables. Opening a profile or copying a work order
  never starts a model. Do not connect paid services without cost approval.
- Notes stay in the vault and are not shown in regular navigation or search.
- Projects come first; unsorted captures appear in Tasks. PromptBar parses
  phrases locally. Project dashboards are added only on request, registered in
  `src/features/projects/dashboards.tsx`.
- Keep focus handling, drafts, finance privacy and access without WebGL.
- Inside an agent session run `npm test` and `npm run test:api`; the build and
  browser suites exceed the 2 GB session budget and run in CI.
- Module guide: [docs/modules/dashboard.md](../docs/modules/dashboard.md).
