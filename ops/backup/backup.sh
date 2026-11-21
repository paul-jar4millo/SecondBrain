#!/bin/sh
# Off-host backup of the vault and DATA_DIR with restic. Run by secondbrain-backup.service
# (environment from /etc/secondbrain/backup.env); can also be run by hand with the same variables.
#
# NOT backed up (by design): anything named "shared" (the Maletín), anything named "secrets",
# the vault's .git (the private SecondBrain-Vault repository has it), node_modules, dist,
# artifacts, tooling, .cache and .workspace-archive; also everything outside VAULT_ROOT and
# DATA_DIR: /var/lib/sb-agente (agent logins, history, hook tokens), /srv/sb-agent/projects
# and /etc/sb-agente.
set -eu
: "${VAULT_ROOT:?Define la ruta física del vault}"
: "${DATA_DIR:?Define el directorio privado de autenticación}"
: "${RESTIC_REPOSITORY:?Define un repositorio restic fuera del host}"
: "${RESTIC_PASSWORD_FILE:?Define la clave de restic fuera del repositorio}"
# Snapshot the canonical Markdown and the authentication configuration, not a SQL mirror.
restic backup "$VAULT_ROOT" "$DATA_DIR" --exclude '**/node_modules' --exclude '**/.git' --exclude '**/.workspace-archive' --exclude '**/artifacts' --exclude '**/dist' --exclude '**/tooling' --exclude '**/.cache' --exclude '**/shared' --exclude '**/secrets' --tag second-brain-vault
# Retention deletes old snapshots, so it is opt-in: BACKUP_PRUNE=1 in backup.env.
if [ "${BACKUP_PRUNE:-0}" = 1 ]; then
  restic forget --tag second-brain-vault --keep-daily "${BACKUP_KEEP_DAILY:-7}" \
    --keep-weekly "${BACKUP_KEEP_WEEKLY:-4}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-6}" --prune
fi
restic check
