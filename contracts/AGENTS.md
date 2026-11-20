# contracts

Shared Zod 4 schemas (threads, items, events, commands, requests, flows,
inbox, usage, stream). Native TypeScript, no build ([ADR 0011](../docs/adr/0011-native-typescript-and-contracts.md)).

- Only erasable syntax: no `enum`, `namespace` or parameter properties.
  Use `as const` objects and `z.enum`.
- Import with explicit `.ts` extensions and `import type` for types.
- Runtime dependency: `zod` only. The release vendors it into
  `contracts/node_modules/zod`; do not add other dependencies.
- Backend code imports `../../contracts/src/index.ts` by relative path.
- Tests: `node --test contracts/tests/*.test.ts`.
