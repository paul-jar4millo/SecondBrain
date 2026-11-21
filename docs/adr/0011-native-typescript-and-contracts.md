# 0011 · Native TypeScript for new backend code and a shared `contracts` module

- Status: accepted
- Date: 2026-11-20

## Context and problem statement

Threads add one schema shared by the launcher, the service, the MCP server,
the dashboard and a Discord bot. The backend is `.mjs` with JSDoc checked by
`tsc`. Node ≥ 24 strips erasable TypeScript syntax at load time, so `.ts`
files can run without a build step.

## Decision drivers

- One source of truth for thread, item, event and command shapes.
- No build step for the backend; releases stay a copy of the sources.
- Compatible with the deploy helper already installed on the host
  ([ADR 0008](0008-npm-workspaces.md)), which installs only `service`, `mcp`
  and `lanzador` and rejects symlinks in the release archive.

## Considered options

1. Keep JSDoc `.mjs` and duplicate schemas.
2. Native TypeScript (type stripping) for new code, with a `contracts`
   workspace written with Zod 4.
3. Compile TypeScript to JavaScript in CI.

## Decision outcome

Chosen option 2.

- New backend code is `.ts`; existing `.mjs` stays until it is rewritten.
  `tsconfig.node.json` enables `allowImportingTsExtensions`,
  `erasableSyntaxOnly` and `verbatimModuleSyntax` (no enums, namespaces or
  parameter properties).
- `contracts/` is an npm workspace (`contracts/src/*.ts`, Zod 4). The
  dashboard uses the same schemas through `zod/mini`-compatible exports.
- Backend modules import contracts by relative path
  (`../../contracts/src/index.ts`). In the release, `contracts/` sits next to
  `lanzador/` and `service/`, so the same relative path resolves.
- The release copies Zod (it has no dependencies) into
  `contracts/node_modules/zod` as plain files, so any deploy helper works
  without installing `contracts`.

Spike (production LXC, Node 24.22.2): a `.mjs` entry importing a `.ts` file that
imports `../../contracts/src/index.ts` and Zod runs without flags; a
workspace symlink also works because Node resolves the real path. A `.ts`
file physically inside `node_modules` fails with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so contracts must never be
copied into a `node_modules` folder.

Fallback: if a relative import ever fails in a packaged release, the packager
converts `.ts` files with `module.stripTypeScriptTypes` (available on the
host) and rewrites `.ts` specifiers to `.js`.

### Consequences

- Good: one schema, real types, no build.
- Bad: two languages in the backend for a while; lint, format, naming and
  coverage tooling must cover `.ts`.
