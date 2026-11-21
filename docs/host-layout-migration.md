# Migrate the native host layout

Use this procedure after installing a Phase 1.5 release that ships both host layouts.
It keeps the Unix account, home directory, UID-based firewall rules, and CLI logins
for `sb-agente`. The containerized application and its vault do not move.

## Rehearse and apply

Rehearse with a disposable LXC and synthetic repositories first. Make sure the
previous release is still present on the real host and its backup is current.
From a root shell in the LXC, run the default read-only plan:

```sh
/opt/node/bin/node /opt/secondbrain/current/ops/migration/migrate-host-layout.mjs
```

The plan reports the current layout, any pending migration, and the managed paths
and unit names. Run the explicit apply command during a maintenance window:

```sh
/opt/node/bin/node /opt/secondbrain/current/ops/migration/migrate-host-layout.mjs --apply
```

The command uses the deployment lock. It stops the summary, app, and remote
control if they are active, waits for the launcher's running work, and stops the
launcher before moving files. The host must store each renamed directory on the
same filesystem as its destination. A conflicting target stops the migration.

The migration changes the launcher state path to
`/var/lib/sb-agent/state/launcher`, repositories to `/srv/sb-agent/projects`,
and deliverables to `/srv/sb-agent/deliverables`. It updates repository links
and structured thread paths in SQLite, preserving the event sequence and user
text. Git repairs the active worktree registrations as `sb-agente`. Existing
data paths, installed commands, and systemd names remain usable through aliases
during the compatibility release.

The marker `/etc/secondbrain/english-layout` selects the canonical names for
future deployments. An interrupted migration records its progress in a root-only
journal. Running the same command again resumes it. Run the release verifier
after the migration:

```sh
bash /opt/secondbrain/current/ops/deploy/verify.sh "$(readlink -f /opt/secondbrain/current)"
```

## Roll back

Use the same release's migration command to put the **current** launcher state
and files back under the legacy names. Run this before activating a prior release
that does not understand the English host marker:

```sh
/opt/node/bin/node /opt/secondbrain/current/ops/migration/migrate-host-layout.mjs --rollback
```

Repeat the verifier. Keep the aliases for the compatibility release and the
rollback window. Local CLI logins and the vault remain in their existing locations.
