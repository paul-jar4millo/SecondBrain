# 0006 · Conventional Commits enforced locally and in CI

- Status: accepted
- Date: 2026-11-08

## Context and problem statement

Humans and agents both commit to this repository, and agents open pull
requests automatically. History has to stay readable and releases need notes.

## Considered options

1. Free-form messages.
2. [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
   checked by a local hook and by CI.

## Decision outcome

Chosen option 2. `ops/check-commit.mjs` validates the subject (types `feat`,
`fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`; optional lowercase scope; `!` for breaking changes). The
`.githooks/commit-msg` hook runs it locally (`git config core.hooksPath
.githooks`) and the `commits` job in CI checks every commit of a push or pull
request, skipping only GitHub's own merge commits. Agent-generated pull
request titles are derived in the same format.

### Consequences

- Good: changelog entries and release notes come straight from history.
- Bad: a local hook can be bypassed; the CI check must be a required status.
