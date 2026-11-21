# 0008 · npm workspaces with per-module release lockfiles

- Status: accepted; the service is no longer installed with `npm ci` on the host ([ADR 0014](0014-container-service-native-launcher.md))
- Date: 2026-11-20

## Context and problem statement

Each module (`dashboard`, `service`, `mcp`, `launcher`) had its own
`package.json` and `package-lock.json`, plus one at the root for the
tooling. Setting up meant five `npm ci` runs, CI cached five lockfiles,
Dependabot opened one pull request per module for the same update, and
shared packages (`@modelcontextprotocol/sdk`, `zod`) could drift between
`service` and `mcp`.

The hosts install each released module on its own:

- `deploy-release.sh` runs `npm ci --prefix <module>` for `service`, `mcp`
  and `lanzador`;
- the `Dockerfile` does the same for `service` and `mcp`.

The installed helper (`/usr/local/sbin/secondbrain-deploy`) only changes
when the operator updates it, so the release format must keep working with
the helper that is already on the host.

## Considered options

1. Keep five lockfiles.
2. npm workspaces, with one root lockfile shipped in the release, and every
   host install changed to a workspace install.
3. npm workspaces in the repository, while the release keeps one lockfile
   per module, cut from the root lockfile.

## Decision outcome

Chosen option 3.

- The root `package.json` declares the four modules as workspaces, and
  `package-lock.json` at the root is the only lockfile. `npm run setup` is a
  single `npm ci`.
- `overrides` live in the root `package.json`; npm ignores them in a
  workspace.
- `ops/package-release.mjs` writes `package-lock.json` for each released
  module with `ops/release-lock.mjs`:
  - it follows Node's resolution from the module through the root
    lockfile;
  - it keeps exactly the versions the root lockfile resolved;
  - it moves them under the module (`launcher` ships as `lanzador/`);
  - packaging fails if two versions would land in the same folder.
- The release layout, `deploy-release.sh`, the installed helper and the
  `Dockerfile` do not change.

### Consequences

- One `npm ci`, one CI cache key, and one Dependabot pull request per update
  for all modules.
- Packages that two modules share resolve to one version unless their ranges
  differ.
- Code must not assume dependencies sit in its own `node_modules`, because
  npm hoists them to the root. Use Node's resolution, or walk up the folders
  as `launcher/tool-catalog.mjs` does.
