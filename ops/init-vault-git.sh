#!/bin/bash
# Run as the vault owner while the knowledge service is stopped.
set -euo pipefail
root=${VAULT_ROOT:?Define VAULT_ROOT}
remote=${1:?Indica el remoto privado del vault}
[[ -f $root/Home.md && -d $root/00-Inbox && ! -L $root ]]
# Only a GitHub SSH remote is accepted; check that it is private before the first push.
[[ $remote =~ ^git@github\.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]
[[ ! -e $root/.git ]] || { echo 'El vault ya tiene Git; revisar su estado, no reinicializar.' >&2; exit 1; }
umask 077
cat >>"$root/.gitignore" <<'IGNORE'

# Operational files and credentials are never knowledge.
.env
.env.*
*.pem
*.key
secrets/
node_modules/
.second-brain-runtime/
.obsidian/workspace*.json
.obsidian/cache/
.obsidian/plugins/
*.tmp
*.bak
IGNORE
git -C "$root" init -b main
git -C "$root" config user.name 'SecondBrain'
git -C "$root" config user.email 'secondbrain@localhost'
git -C "$root" config core.fileMode false
git -C "$root" config core.logAllRefUpdates true
git -C "$root" remote add origin "$remote"
git -C "$root" add --all
git -C "$root" commit -m 'Vault independiente: estado inicial'
echo 'Repositorio inicializado. Verificar privacidad del remoto antes del primer push.'
