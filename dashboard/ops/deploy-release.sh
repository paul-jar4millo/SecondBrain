#!/bin/bash
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
rollback_only=false
if [[ ${1:-} == --rollback ]]; then rollback_only=true; shift; fi
[[ $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { echo 'Se requiere el SHA completo del commit.' >&2; exit 2; }
sha=$1
exec 9>/run/lock/secondbrain-deploy.lock
flock -n 9 || { echo 'Ya hay un despliegue en curso.' >&2; exit 1; }
incoming=/var/lib/sb-runner/incoming/$sha/release.tar.gz
release=/opt/secondbrain/releases/$sha
# Public health URL (through the proxy); empty skips that check, as in rehearsal containers.
public_health=
[[ -f /etc/secondbrain/health-url ]] && public_health=$(head -n1 /etc/secondbrain/health-url)
check_public() {
  [[ -z $public_health ]] || curl -fsS --retry 3 --retry-delay 1 --max-time 5 "$public_health"
}
# Restarting the launcher ends every running session. Dashboard-only releases
# leave intact the code it loads at start-up, so sessions survive them.
launcher_pin=/etc/secondbrain/launcher-release
launcher_override=/etc/systemd/system/secondbrain-lanzador.service.d/50-secondbrain-release.conf
compatibility_helper=/usr/local/lib/secondbrain/launcher-compatible.mjs
launcher_source_release() {
  local source=${old:-}
  [[ ! -f /run/secondbrain-launcher-release ]] || source=$(cat /run/secondbrain-launcher-release)
  [[ ! -f $launcher_pin ]] || source=$(cat "$launcher_pin")
  [[ $source =~ ^/opt/secondbrain/releases/[a-f0-9]{40}$ ]] || return 1
  printf '%s\n' "$source"
}
pin_launcher_release() {
  local source=$1 blocked=${2:-false}
  install -d -o root -g root -m 0755 /etc/secondbrain "$(dirname "$launcher_override")"
  if [[ $source =~ ^/opt/secondbrain/releases/[a-f0-9]{40}$ ]]; then
    printf '%s\n' "$source" >"$launcher_pin.tmp"
    chown root:root "$launcher_pin.tmp"
    chmod 0644 "$launcher_pin.tmp"
    mv -f "$launcher_pin.tmp" "$launcher_pin"
  fi
  {
    printf '[Service]\nExecStart=\n'
    if $blocked; then
      # Even a later manual start must not open an unverified registry.
      printf 'ExecStart=/usr/bin/false\nWorkingDirectory=/\n'
    else
      printf 'ExecStart=/opt/node/bin/node %s/server/lanzador.mjs\nWorkingDirectory=%s\n' "$source" "$source"
    fi
  } >"$launcher_override.tmp"
  chown root:root "$launcher_override.tmp"
  chmod 0644 "$launcher_override.tmp"
  mv -f "$launcher_override.tmp" "$launcher_override"
  systemctl daemon-reload
}
launcher_code_unchanged() {
  [[ -n ${old:-} ]] || return 1
  local module launcher_target=$1 launcher_source
  launcher_source=$(launcher_source_release) || return 1
  for module in server service lanzador; do
    [[ -d $launcher_source/$module && -d $launcher_target/$module ]] || return 1
    diff -rq --exclude=node_modules --exclude=tests \
      "$launcher_source/$module" "$launcher_target/$module" >/dev/null 2>&1 || return 1
  done
}
restart_services() {
  systemctl restart secondbrain
  if ! systemctl cat secondbrain-lanzador.service >/dev/null 2>&1; then
    return
  fi
  local launcher_target launcher_source selected index
  # Resolve current again: an ERR rollback trap may have changed its target.
  launcher_target=$(readlink -f /opt/secondbrain/current)
  launcher_source=$(launcher_source_release || true)
  index=${SB_LANZADOR_DATA_DIR:-/var/lib/sb-agente/estado/lanzador}/sesiones.json
  if ! selected=$(/opt/node/bin/node "$compatibility_helper" --select "$index" \
    "$launcher_target" "$launcher_source" "${old:-}" "$release"); then
    pin_launcher_release "$launcher_source" true
    echo 'AVISO: servicio actualizado; lanzador pendiente y arranque bloqueado por índice o capacidad no verificables.' >&2
    return
  fi
  if [[ $selected != "$launcher_target" ]]; then
    pin_launcher_release "$selected"
    echo 'AVISO: servicio actualizado; lanzador pendiente por incompatibilidad de datos. Se conserva la release compatible, incluso tras reiniciar el host.' >&2
    return
  fi
  if launcher_code_unchanged "$launcher_target"; then
    [[ -f /run/secondbrain-launcher-release ]] || printf '%s\n' "$old" >/run/secondbrain-launcher-release
    echo 'El código del lanzador no cambió; las sesiones siguen vivas.'
    return
  fi
  if systemctl is-active --quiet secondbrain-lanzador && \
    ! /opt/node/bin/node "$launcher_target/ops/deploy/wait-launcher.mjs"; then
    # Pin the release still used by the running process across future pruning.
    if /opt/node/bin/node "$compatibility_helper" "$launcher_source" "$index"; then
      pin_launcher_release "$launcher_source"
    else
      pin_launcher_release "$launcher_source" true
    fi
    echo 'AVISO: servicio actualizado; lanzador pendiente. No se interrumpieron las sesiones.' >&2
    return
  fi
  # Remove only this deployer's override; preserve every administrator drop-in.
  rm -f -- "$launcher_override" "$launcher_pin"
  systemctl daemon-reload
  systemctl restart secondbrain-lanzador
  printf '%s\n' "$(readlink -f /opt/secondbrain/current)" >/run/secondbrain-launcher-release
}
if $rollback_only; then
  [[ -f $release/REVISION && $(cat "$release/REVISION") == "$sha" ]]
  old=$(readlink -f /opt/secondbrain/current)
  trap 'ln -sfn "$old" /opt/secondbrain/current; restart_services' ERR
  ln -sfn "$release" /opt/secondbrain/current
  restart_services
  curl -fsS --retry 15 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:8080/api/v1/health
  trap - ERR
  echo "Rollback a $sha. Vault y credenciales conservados."
  exit 0
fi
[[ -f $incoming && ! -L $incoming ]]
if [[ -f /opt/secondbrain/current/REVISION && $(cat /opt/secondbrain/current/REVISION) == "$sha" ]]; then
  check_public
  if [[ -f $release/ops/deploy/check-drift.sh ]]; then
    bash "$release/ops/deploy/check-drift.sh" "$release" || \
      echo 'AVISO: sigue pendiente aplicar configuración operativa.' >&2
  fi
  echo "Commit $sha ya desplegado."
  exit 0
fi
[[ ! -e $release ]] || { echo 'La release ya existe; revisar antes de reutilizarla.' >&2; exit 1; }
stage=$(mktemp -d /opt/secondbrain/releases/.stage-XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
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
test -f "$stage/server/index.mjs"
if [[ -f $stage/service/index.mjs ]]; then
  test -f "$stage/dashboard/dist/index.html"
  test -f "$stage/mcp/index.mjs"
else
  test -f "$stage/dist/index.html"
fi
chown -R sb-runner:sb-runner "$stage"
if [[ -f $stage/service/package.json ]]; then
  for module in service mcp lanzador; do
    runuser -u sb-runner -- npm ci --prefix "$stage/$module" --omit=dev --ignore-scripts --no-audit --no-fund
  done
else
  runuser -u sb-runner -- npm ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund
fi
printf '%s\n' "$sha" > "$stage/REVISION"
chown -R root:root "$stage"
chmod -R u=rwX,go=rX "$stage"
mv "$stage" "$release"
# On a fresh install there is no previous release to go back to.
old=
[[ -e /opt/secondbrain/current ]] && old=$(readlink -f /opt/secondbrain/current)
rollback() {
  trap - ERR
  if [[ -n $old ]]; then
    echo 'Falló el health check; restaurando la release anterior.' >&2
    ln -sfn "$old" /opt/secondbrain/current
    restart_services
  else
    echo 'Falló el health check en la primera release; no hay anterior.' >&2
    rm -f /opt/secondbrain/current
    systemctl stop secondbrain || true
  fi
  exit 1
}
trap rollback ERR
ln -sfn "$release" /opt/secondbrain/current
restart_services
curl -fsS --retry 15 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:8080/api/v1/health
systemctl is-active --quiet secondbrain
check_public
if [[ -f $release/ops/deploy/check-drift.sh ]]; then
  bash "$release/ops/deploy/check-drift.sh" "$release" || \
    echo 'AVISO: aplicar los cambios operativos según docs/deployment.md.' >&2
fi
trap - ERR
while read -r candidate; do
  [[ $candidate =~ ^/opt/secondbrain/releases/[a-f0-9]{40}$ ]] || exit 1
  launcher_release=$(cat /run/secondbrain-launcher-release 2>/dev/null || true)
  launcher_persistent=$(cat "$launcher_pin" 2>/dev/null || true)
  [[ $candidate == "$release" || $candidate == "$old" || $candidate == "$launcher_release" || $candidate == "$launcher_persistent" ]] || rm -rf -- "$candidate"
done < <(find /opt/secondbrain/releases -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '/opt/secondbrain/releases/[a-f0-9]{40}' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
echo "Desplegado $sha. Vault y credenciales conservados."
