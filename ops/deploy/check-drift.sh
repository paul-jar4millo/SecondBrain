#!/usr/bin/env bash
# Read-only drift report. Missing configuration is reported, never applied implicitly.
set -euo pipefail
release=${1:?Falta release}
root=${2:-}
if [[ -f $root/etc/secondbrain/parameters.json && -f $release/ops/deploy/configure.mjs ]]; then
  exec /opt/node/bin/node "$release/ops/deploy/configure.mjs" --release "$release" --root "${root:-/}" --parameters "$root/etc/secondbrain/parameters.json" --check
fi
drift=0
check() {
  local source=$1 target=$2
  if ! cmp -s -- "$source" "$root$target"; then
    printf 'AVISO: configuración pendiente: %s\n' "$target" >&2
    drift=1
  fi
}
check "$release/ops/deploy/deploy-release.sh" /usr/local/sbin/secondbrain-deploy
check "$release/ops/deploy/launcher-compatible.mjs" /usr/local/lib/secondbrain/launcher-compatible.mjs
for unit in secondbrain-lanzador.service claude-sb-agente.service resumen-matutino.service resumen-matutino.timer; do
  check "$release/ops/lanzador/$unit" "/etc/systemd/system/$unit"
done
for unit in secondbrain-vault-push.service secondbrain-vault-push.timer; do
  check "$release/ops/deploy/$unit" "/etc/systemd/system/$unit"
done
for unit in secondbrain-backup.service secondbrain-backup.timer; do
  check "$release/ops/backup/$unit" "/etc/systemd/system/$unit"
done
check "$release/ops/aviso/secondbrain-aviso@.service" '/etc/systemd/system/secondbrain-aviso@.service'
if [[ -f $root/etc/secondbrain/ops.env ]]; then
  # Root-owned deployment parameters, never agent-controlled input.
  # shellcheck source=/dev/null
  source "$root/etc/secondbrain/ops.env"
  : "${PROXY_IP:?}" "${GATEWAY:?}" "${AGENTE_UID:?}"
  temp=$(mktemp -d)
  trap 'rm -rf -- "$temp"' EXIT
  sed "s|@PROXY_IP@|$PROXY_IP|g" "$release/ops/lxc/plantillas/secondbrain.service" >"$temp/service"
  check "$temp/service" /etc/systemd/system/secondbrain.service
  sed -e "s|@PROXY_IP@|$PROXY_IP|g" -e "s|@GATEWAY@|$GATEWAY|g" -e "s|@UID@|$AGENTE_UID|g" \
    "$release/ops/lxc/plantillas/nftables.conf" >"$temp/nftables"
  check "$temp/nftables" /etc/nftables.conf
else
  echo 'AVISO: falta /etc/secondbrain/ops.env; no se pudo comparar servicio y firewall.' >&2
  drift=1
fi
exit "$drift"
