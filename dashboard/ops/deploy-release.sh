#!/bin/bash
set -Eeuo pipefail
export PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
rollback_only=false
if [[ ${1:-} == --rollback ]]; then rollback_only=true; shift; fi
[[ $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full commit SHA.' >&2; exit 2; }
sha=$1
exec 9>/run/lock/secondbrain-deploy.lock
flock -n 9 || { echo 'A deployment is already running.' >&2; exit 1; }
incoming=/var/lib/sb-runner/incoming/$sha/release.tar.gz
release=/opt/secondbrain/releases/$sha
# Public health URL (through the proxy); empty skips that check, as in rehearsal containers.
public_health=
[[ -f /etc/secondbrain/health-url ]] && public_health=$(head -n1 /etc/secondbrain/health-url)
check_public() {
  [[ -z $public_health ]] || curl -fsS --retry 3 --retry-delay 1 --max-time 5 "$public_health"
}
parameters=/etc/secondbrain/parameters.json
launcher=secondbrain-launcher.service
current=/opt/secondbrain/current
quadlet=/etc/containers/systemd/secondbrain-container.container
registry=/etc/secondbrain/image-repository
old=$(readlink -f "$current" 2>/dev/null || true)

apply_configuration() {
  local target=$1
  if [[ -f $target/ops/deploy/verify.sh ]]; then
    node "$target/ops/deploy/configure.mjs" --release "$target" --parameters "$parameters" --skip-helper
    # Releases before v0.6 ship the installer under ops/lanzador; a rollback may target one.
    local installer=$target/ops/launcher/install.sh
    [[ -f $installer ]] || installer=$target/ops/lanzador/install.sh
    SB_RELEASE="$target" SB_ACTIVATE=0 bash "$installer"
  fi
  systemctl daemon-reload
  nft -c -f /etc/nftables.conf
  systemctl reload-or-restart nftables.service
}

container_unit() {
  node "$1/ops/deploy/render-container.mjs" "$1/image-reference" \
    "$parameters" "$registry" "$(id -u secondbrain)" "$(id -g secondbrain)"
}

prepare_image() {
  local target=$1
  [[ -f $target/image-reference ]] || return 0
  local image
  image=$(container_unit "$target" | sed -n 's/^Image=//p')
  [[ -n $image ]]
  if ! podman image exists "$image"; then
    local auth=()
    [[ ! -f /etc/secondbrain/registry-auth.json ]] || auth=(--authfile /etc/secondbrain/registry-auth.json)
    podman pull "${auth[@]}" "$image"
  fi
}

start_release() {
  local target=$1
  if [[ -f $target/image-reference ]]; then
    install -d -m 0755 "$(dirname "$quadlet")"
    container_unit "$target" >"$quadlet.tmp"
    chmod 0644 "$quadlet.tmp"
    mv -f "$quadlet.tmp" "$quadlet"
    [[ -e /run/secondbrain-launcher-release ]] || install -m 0644 /dev/null /run/secondbrain-launcher-release
    systemctl disable --now secondbrain.service
    systemctl daemon-reload
    systemctl restart secondbrain-container.service
  else
    if [[ -f $quadlet ]]; then
      systemctl stop secondbrain-container.service
      rm -f -- "$quadlet"
      systemctl daemon-reload
    fi
    systemctl enable secondbrain.service
    systemctl restart secondbrain.service
  fi
  systemctl restart "$launcher"
}

verify_release() {
  local target=$1
  if [[ -f $target/ops/deploy/verify.sh ]]; then
    bash "$target/ops/deploy/verify.sh" "$target"
  else
    curl -fsS --retry 15 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:8080/api/v1/health
    systemctl is-active --quiet secondbrain.service "$launcher"
  fi
  check_public
}

rollback() {
  trap - ERR
  set +e
  echo "Activation failed; restoring previous service and launcher." >&2
  for name in secondbrain.service "$launcher"; do
    [[ ! -f $config_backup/$name ]] || cp -a "$config_backup/$name" "/etc/systemd/system/$name"
  done
  [[ ! -f $config_backup/nftables.conf ]] || cp -a "$config_backup/nftables.conf" /etc/nftables.conf
  if [[ -n $old && -f $old/REVISION ]]; then
    ln -sfn "$old" "$current"
    apply_configuration "$old" && start_release "$old" && verify_release "$old"
  else
    rm -f -- "$current"
    systemctl stop secondbrain.service secondbrain-container.service "$launcher"
    rm -f -- "$quadlet"
    systemctl daemon-reload
  fi
  exit 1
}

activate() {
  local target=$1
  prepare_image "$target"
  local checker=$target/ops/deploy/wait-launcher.mjs
  if systemctl is-active --quiet "$launcher"; then
    [[ -f $checker ]] || checker=$old/ops/deploy/wait-launcher.mjs
    node "$checker" || return 1
  fi
  config_backup=$(mktemp -d /run/secondbrain-config-XXXXXXXX)
  # Back up exactly the generated files that can differ across a rollback.
  for name in secondbrain.service "$launcher"; do
    [[ ! -f /etc/systemd/system/$name ]] || cp -a "/etc/systemd/system/$name" "$config_backup/$name"
  done
  [[ ! -f /etc/nftables.conf ]] || cp -a /etc/nftables.conf "$config_backup/nftables.conf"
  trap rollback ERR
  apply_configuration "$target"
  ln -sfn "$target" "$current"
  start_release "$target"
  verify_release "$target"
  trap - ERR
  echo "Activated $(cat "$target/REVISION")."
}
if $rollback_only; then
  [[ -f $release/REVISION && $(cat "$release/REVISION") == "$sha" ]]
  trap '[[ -z ${config_backup:-} ]] || rm -rf -- "$config_backup"' EXIT
  activate "$release"
  exit 0
fi
[[ -f $incoming && ! -L $incoming ]]
if [[ -f $release/REVISION && $(cat "$release/REVISION") == "$sha" ]]; then
  trap '[[ -z ${config_backup:-} ]] || rm -rf -- "$config_backup"' EXIT
  activate "$release"
  exit 0
fi
[[ ! -e $release ]] || { echo 'La release ya existe; revisar antes de reutilizarla.' >&2; exit 1; }
stage=$(mktemp -d /opt/secondbrain/releases/.stage-XXXXXXXX)
trap 'rm -rf -- "$stage"; [[ -z ${config_backup:-} ]] || rm -rf -- "$config_backup"' EXIT
cp -- "$incoming" "$stage/release.tar.gz"
python3 - "$stage/release.tar.gz" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for item in archive.getmembers():
        p = PurePosixPath(item.name)
        if p.is_absolute() or ".." in p.parts or not (item.isfile() or item.isdir()):
            raise SystemExit("Paquete con ruta o tipo de archivo no permitido")
        if p.parts and p.parts[0] in {"vault", "obsidian", ".data"}:
            raise SystemExit("El paquete no puede incluir datos personales")
PY
tar -xzf "$stage/release.tar.gz" --no-same-owner -C "$stage"
rm "$stage/release.tar.gz"
if [[ -f $stage/image-reference ]]; then
  test -f "$stage/launcher/index.mjs"
  test -f "$stage/mcp/index.mjs"
else
  test -f "$stage/server/index.mjs"
  test -f "$stage/dashboard/dist/index.html"
  test -f "$stage/mcp/index.mjs"
fi
chown -R sb-runner:sb-runner "$stage"
if [[ -f $stage/launcher/package.json ]]; then
  modules=(mcp launcher)
  if [[ ! -f $stage/image-reference ]]; then modules+=(service); fi
  for module in "${modules[@]}"; do
    runuser -u sb-runner -- npm ci --prefix "$stage/$module" --omit=dev --ignore-scripts --no-audit --no-fund
  done
else
  echo "Invalid native runtime artifact." >&2
  exit 1
fi
printf '%s\n' "$sha" > "$stage/REVISION"
chown -R root:root "$stage"
chmod -R u=rwX,go=rX "$stage"
mv "$stage" "$release"
activate "$release"
while read -r candidate; do
  [[ $candidate =~ ^/opt/secondbrain/releases/[a-f0-9]{40}$ ]] || exit 1
  launcher_release=$(cat /run/secondbrain-launcher-release 2>/dev/null || true)
  [[ $candidate == "$release" || $candidate == "$old" || $candidate == "$launcher_release" ]] || rm -rf -- "$candidate"
done < <(find /opt/secondbrain/releases -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '/opt/secondbrain/releases/[a-f0-9]{40}' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
echo "Desplegado $sha. Vault y credenciales conservados."
