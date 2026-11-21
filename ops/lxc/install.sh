#!/usr/bin/env bash
# Desde la PC (Git Bash), en este repo y con el commit que quieres desplegar.
# Crea el LXC de SecondBrain en Proxmox VE y lo deja funcionando, salvo las cuentas
# de los motores (después: inside/connect.sh, interactivo).
#
#   bash ops/lxc/install.sh [lxc.env] [--reusar]
#
# Requisitos: `ssh $HOST_SSH` sin contraseña, `gh` autenticado, `npm run setup` hecho.
# Copia ops/lxc/lxc.env.example a ops/lxc/lxc.env (ignorado por git) y edítalo.
# --reusar: no crea el LXC; aprovisiona uno que ya existe con ese VMID.
set -euo pipefail
raiz=$(git rev-parse --show-toplevel)
cd "$raiz"
conf=ops/lxc/lxc.env reusar=false
for a in "$@"; do case $a in --reusar) reusar=true ;; *) conf=$a ;; esac; done
[[ -f $conf ]] || { echo "Falta $conf: copia ops/lxc/lxc.env.example y edítalo." >&2; exit 2; }
# shellcheck source=/dev/null
source "$conf"
[[ ${HOST_SSH:-} =~ ^[A-Za-z0-9._@-]+$ ]] || { echo 'HOST_SSH inválido' >&2; exit 2; }
[[ $VMID =~ ^[1-9][0-9]{2,8}$ ]] || { echo 'VMID inválido' >&2; exit 2; }
[[ $CPU =~ ^[1-9][0-9]*$ && $MEMORIA_MB =~ ^[1-9][0-9]*$ && $DISCO_GB =~ ^[1-9][0-9]*$ ]] || { echo 'Recursos inválidos' >&2; exit 2; }

[[ -z $(git status --porcelain) ]] || { echo "Hay cambios sin commit: la release debe salir de un commit." >&2; exit 1; }
sha=$(git rev-parse HEAD)
dentro() { ssh "$HOST_SSH" "pct exec $VMID -- $*"; }

echo "== Compilando la release $sha"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
npm run build --silent
node ops/package-release.mjs "$tmp/release" >/dev/null
mkdir -p "$tmp/sb-lxc/vault-push"
tar --owner=0 --group=0 -czf "$tmp/sb-lxc/release.tar.gz" -C "$tmp/release" .
cp -r ops/lxc/host ops/lxc/inside ops/lxc/templates "$tmp/sb-lxc/"
cp "$conf" "$tmp/sb-lxc/lxc.env"
cp dashboard/ops/deploy-release.sh "$tmp/sb-lxc/"
cp ops/secondbrain-vault-push.service ops/secondbrain-vault-push.timer "$tmp/sb-lxc/vault-push/"
tar --owner=0 --group=0 -czf "$tmp/sb-lxc.tgz" -C "$tmp" sb-lxc

echo "== Copiando al host"
remote_dir=$(ssh "$HOST_SSH" "mktemp -d /tmp/sb-lxc-$VMID.XXXXXXXX")
[[ $remote_dir =~ ^/tmp/sb-lxc-$VMID\.[A-Za-z0-9]+$ ]] || { echo 'Directorio temporal remoto inválido' >&2; exit 1; }
scp -q "$tmp/sb-lxc.tgz" "$HOST_SSH:$remote_dir/package.tgz"
ssh "$HOST_SSH" "touch '$remote_dir/.secondbrain-bootstrap' && tar --no-same-owner -xzf '$remote_dir/package.tgz' -C '$remote_dir'"
if $reusar; then
  ssh "$HOST_SSH" "pct status $VMID" >/dev/null
else
  ssh "$HOST_SSH" "bash '$remote_dir/sb-lxc/host/create-lxc.sh' '$remote_dir/sb-lxc/lxc.env'"
fi
ssh "$HOST_SSH" "pct push $VMID '$remote_dir/package.tgz' /root/sb-lxc.tgz && test -f '$remote_dir/.secondbrain-bootstrap' && test \$(stat -c %u '$remote_dir') = 0 && rm -rf -- '$remote_dir'"
dentro "bash -c 'tar --no-same-owner -xzf /root/sb-lxc.tgz -C /root && rm /root/sb-lxc.tgz'"

echo "== Aprovisionando"
dentro bash /root/sb-lxc/inside/provision.sh base

if [[ -n $REPO_VAULT ]]; then
  echo "== Llave de despliegue del vault en $REPO_VAULT"
  dentro cat /var/lib/secondbrain/vault-git/id_ed25519.pub >"$tmp/vault.pub"
  llave=$(cut -d' ' -f1-2 "$tmp/vault.pub")
  if gh api "repos/$REPO_VAULT/keys" --jq '.[].key' | grep -qxF "$llave"; then
    echo "La llave ya estaba registrada."
  else
    gh repo deploy-key add "$tmp/vault.pub" --repo "$REPO_VAULT" --allow-write --title "$NOMBRE $(date +%F)"
  fi
fi
dentro bash /root/sb-lxc/inside/provision.sh vault
dentro bash /root/sb-lxc/inside/provision.sh desplegar "$sha"

if [[ -n $RUNNER_NOMBRE ]]; then
  echo "== Runner de GitHub"
  # El token de registro dura una hora y pasa directo de gh al LXC por stdin.
  gh api -X POST "repos/$REPO_APP/actions/runners/registration-token" --jq .token |
    ssh "$HOST_SSH" "pct exec $VMID -- bash /root/sb-lxc/inside/provision.sh runner"
fi

echo "== Verificación"
dentro bash /root/sb-lxc/inside/verify.sh
cat <<EOF

Siguiente paso (interactivo, en tu terminal):
  ssh -t $HOST_SSH pct enter $VMID
  bash /root/sb-lxc/inside/connect.sh
EOF
