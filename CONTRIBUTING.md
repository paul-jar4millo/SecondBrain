# Contributing

Thanks for your interest! Please read the [code of conduct](CODE_OF_CONDUCT.md)
first. For security issues, follow [SECURITY](SECURITY.md) instead of opening
an issue.

## Setup

```sh
npm run setup                       # installs every module (Node.js 24)
git config core.hooksPath .githooks # commit-message hook
npm run dev                         # http://127.0.0.1:5173/?demo=1
```

Work with synthetic data only. Tests create their own vaults in temporary
directories; never point `VAULT_ROOT` at real notes while developing.

## Before opening a pull request

```sh
npm run lint && npm run format:check && npm run typecheck
npm test && npm run test:api && npm run test:ops
npm run build
npm --prefix dashboard run verify:browser   # for UI changes
```

Update the docs in `docs/` when behavior changes, and add an ADR in
`docs/adr/` for decisions that are hard to reverse.

## Commit messages

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
type(optional-scope): description
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. Types are lowercase; a scope starts with a letter or
digit and may contain lowercase letters, digits, `.`, `-`, `/` and `_`. Mark
breaking changes with `!` before the colon or a `BREAKING CHANGE:` footer.

Examples: `feat(projects): add a panel`, `fix(vault): keep unknown YAML fields`,
`docs: update installation`.

The hook (`.githooks/commit-msg` → `ops/check-commit.mjs`) checks the subject
locally and the `commits` CI job checks every commit of a pull request. Prefer
squash or rebase merges.

## Language

- User interface: Spanish by default, with English through `dashboard/src/i18n/`.
  Add every new user-facing string to both dictionaries.
- Code identifiers, comments and documentation: English. Some module and
  domain names (`lanzador`, `sala`, `encargos`) are Spanish and stay as they are.

## Module rules

Each module has an `AGENTS.md` with its rules (they apply to humans too):
[root](AGENTS.md), [service](service/AGENTS.md), [mcp](mcp/AGENTS.md),
[dashboard](dashboard/AGENTS.md).
