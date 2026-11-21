# 0014 · Self-hosted LXC: the service runs as an OCI image, the launcher stays native

- Status: accepted
- Date: 2026-11-21 (decided for phase 1.5, shipped in v0.5.0, #58)
- Supersedes: the release layout part of
  [ADR 0007](0007-english-identifiers.md) and the host `npm ci` for `service`
  described in [ADR 0008](0008-npm-workspaces.md).

## Context and problem statement

SecondBrain runs on one machine the owner controls: an unprivileged LXC
container on a Proxmox VE host in a homelab. Until v0.4 every module was
installed natively from a release folder with `npm ci` on the host. Several
deploys broke in ways CI did not see:

- v0.3.1 shipped without a version marker, and the host kept an old launcher
  without warning;
- v0.4.0 changed the code but not the systemd units, so the host drifted
  until it was re-provisioned by hand;
- state was spread over `/opt`, `/etc`, `/var/lib` and `/srv`, with mixed
  Spanish and English names.

The next phases add more services (push notifications, a Discord bot, a
daily summary), and each would multiply these problems.

## Decision drivers

- Self-hosting: notes and finances stay on hardware the owner controls; the
  homelab already exists, so there is no monthly bill; and the agent CLIs
  need a real host with interactive logins, worktrees and per-user isolation.
- A deploy must apply everything it needs and verify itself, or roll back.
- Rollback must be one step, and tested.
- Agent isolation (ADR 0003) must not get weaker.

## Considered options

1. Keep the native install and harden the scripts.
2. Everything in containers, including the launcher (Docker inside the LXC,
   or a VM).
3. Service, MCP and dashboard as one OCI image run by Podman and Quadlet;
   the launcher stays native but becomes declarative.
4. A cloud VPS or managed platform instead of the homelab.

## Decision outcome

Chosen option 3.

- CI builds one image (`dashboard/Dockerfile`: service, MCP, dashboard and
  contracts; non-root user; health check; SBOM), pushes it to GHCR and
  smoke-tests it by digest. The host runs it with a Quadlet unit
  (`secondbrain-container.container`, rendered by
  `ops/deploy/render-container.mjs`) pinned to that digest. Rollback is the
  previous digest.
- The launcher is not containerized. It depends on things that a nested
  container in an unprivileged LXC complicates without any gain: a separate
  Unix user with nftables rules, one `systemd-run` scope per thread with
  memory and CPU limits, the CLIs' interactive logins, and worktrees on disk.
  Instead it is declarative: every deploy runs the same idempotent
  `install.sh` and `configure.mjs`, units are regenerated each time
  (`ops/deploy/check-drift.sh`, run by `verify.sh`, reports any drift), and
  CLI versions are pinned
  ([ADR 0016](0016-pinned-agent-clis.md)).
- `ops/deploy/verify.sh` ships in the release and runs at the end of every
  deploy. Any failure restores the previous release, image digest and
  configuration.
- Option 2 was rejected because it duplicates the isolation the LXC already
  gives, and agents need the host as it is. Option 4 was rejected for the
  privacy, cost and agent-host reasons above.
- Docker Compose (`dashboard/compose.yml`) stays as the simple way to try the
  app without agents.

### Consequences

- Good: no `npm ci` for the service on the host. Deploying or rolling back the
  service is a digest switch; the automatic rollback was exercised for real
  (v0.5.1) and by digest (v0.5.3 → v0.5.2 → v0.5.3).
- Good: one host to secure and back up, and no inbound ports besides HTTPS
  through the reverse proxy.
- Bad: two deployment styles to understand (image and native launcher).
- Bad: one host is a single point of failure. There is no high availability;
  backups (restic and the vault remote) are the recovery plan.
