# 0015 · Deploy only from version tags, with approval, through an outbound runner

- Status: accepted
- Date: 2026-11-21 (records a choice made on 2026-11-17)

## Context and problem statement

The production host sits in a home network with no inbound ports other than
HTTPS through the reverse proxy. The repository is public, accepts pull
requests, and agents push branches and open pull requests themselves. A
deployment changes the only running copy of the system.

## Decision drivers

- Nothing from a fork or a pull request may run on the production host.
- No SSH or other inbound access from the internet to the host.
- Every release is reviewable, reproducible and reversible.
- Merging to `main` (often an agent's pull request) is not the same decision
  as shipping.

## Considered options

1. Deploy on every push to `main` from a GitHub-hosted runner over SSH.
2. An agent on the host that polls for new images (for example
   `podman auto-update` alone).
3. Deploy on `v*` tags only: build on a GitHub-hosted runner, wait for a
   manual approval in the `production` environment, then activate on a
   self-hosted runner that downloads only the built artifact.

## Decision outcome

Chosen option 3 (`.github/workflows/deploy.yml`).

- `build` runs on GitHub's runners: tests, image, SBOM, package and SHA-256.
- `deploy` needs the `production` environment's required reviewer. The
  environment only accepts `v*` tags, and the job only runs when
  `github.repository_owner` equals the `SB_DEPLOY_OWNER` variable, so forks
  never reach the runner.
- The self-hosted runner only makes outbound connections. It never checks out
  the repository: it verifies the artifact checksum and calls the privileged
  helper `/usr/local/sbin/secondbrain-deploy` through a narrow `sudo` rule.
- Health is checked locally and, when `SB_PUBLIC_URL` is set, from outside. A
  failure rolls back automatically.
- `main` is protected by a ruleset (pull request plus the `verify`, `commits`
  and `audit` checks). Release tags cannot be moved or deleted.
- Workflows default to `contents: read` and pin every action to a commit SHA.

### Consequences

- Good: a merged pull request never changes production by itself.
- Good: the host exposes nothing new to the internet.
- Bad: releasing is a manual sequence (version bump, changelog, tag,
  approval).
- Bad: the runner is a privileged service on the host and must be kept up to
  date.
