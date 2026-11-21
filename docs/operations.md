# Operations

Day-two tasks for the [container install](deployment.md#proxmox-ve-container-full-install).
Commands run inside the container as root unless stated otherwise.

## Health and logs

```sh
systemctl is-active secondbrain-container secondbrain-launcher
cat /opt/secondbrain/current/REVISION
journalctl -u secondbrain-container -n 50 --no-pager
curl -fsS http://127.0.0.1:8080/api/v1/health
```

`/api/v1/health` reports API availability separately from a `maintenance`
field: a missing, failed or older-than-26-hours backup marks maintenance as
degraded, and so does a runner still on an older revision.

The dashboard reads the same field every 30 minutes and shows a failed,
overdue or unreadable backup in the reminders panel (the bell gets a dot). A
backup that was never set up is not flagged. The Windows scheduled task always
ends with result 0 because it runs headless through `conhost`, so rely on the
dashboard or the health endpoint, not on the task's last result.

## Backups

| What                       | How                                                                                          | When                    |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| Vault                      | isomorphic-git commits + `secondbrain-vault-push.timer` to a private remote (own deploy key) | Every 10 minutes        |
| Vault + `DATA_DIR`         | `secondbrain-backup.timer` → restic, configured in `/etc/secondbrain/backup.env`             | Daily 03:30 ± 30 min    |
| Whole container (optional) | `ops/backup/host-backup.sh` on the host + `windows-backup.ps1` (restic) on a PC              | Daily data, weekly full |

Without `backup.env` the backup unit is skipped, and the health endpoint says
so — a disabled timer is never reported as a working backup.

The launcher keeps its state in `threads.sqlite` under `SB_LAUNCHER_DATA_DIR`
(`/var/lib/sb-agent/state/launcher`, see
[ADR 0009](adr/0009-operational-state-in-sqlite.md)). A nightly
`VACUUM INTO` writes a consistent copy for the backup; restore it with the
launcher stopped.

`ops/migration/manifest.py` inventories content and hashes of a data set
(`scan`) and checks a restored copy against it (`verify`). Keep real
policies and manifests with the private backup, never in this repository.

## Alerts

The service, runner, vault push and backup units use
`OnFailure=secondbrain-notify@%n.service`. Put `AVISO_URL` (a self-hosted
ntfy topic or webhook) and optionally `AVISO_FORMATO=json` in
`/etc/secondbrain/aviso.env`. Without that file nothing is sent.

## Rollback

```sh
/usr/local/sbin/secondbrain-deploy --rollback <full-sha-of-an-existing-release>
```

This switches code only. Never reset the vault or restore credentials as
part of a software rollback.

Before restarting the launcher, the helper asks it for threads that are
mid-turn (`ops/deploy/wait-launcher.mjs`). It waits up to 15 minutes for them
to finish; if they do not, or the launcher cannot be read, the deployment
stops before changing anything.

## Recovering a note

Read the older version from Git in a separate checkout (or `git show`), then
write it back through the API or MCP with the note's current hash. Never run
`pull`, `reset` or `checkout` on the live vault.

## Rebuilding the container

1. Freeze writes and deployments; take a consistent backup and a manifest.
2. Rehearse the restore with a different VMID, `onboot=0` and the network
   disconnected; disable timers, runner and agents before the first start.
3. Install the new container with `ops/lxc/install.sh`, restore data by
   manifest and reconnect provider accounts by hand.
4. Check API, MCP, briefcase, projects, permissions and network rules.
5. Keep the old container until the new one has been observed in use.

Adding a repository for agents:

```sh
bash /opt/secondbrain/current/ops/launcher/add-repo.sh <owner/repo> [project-id]
```

It clones as `sb-agente`, registers the repository in `SB_PROJECTS_FILE` and
restarts the launcher, refusing to do so while a thread is working.
