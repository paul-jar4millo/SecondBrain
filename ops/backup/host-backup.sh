#!/usr/bin/env bash
# Run on the container host (Proxmox VE) as root; all binary output is consumed
# directly by restic. SB_VMID (or /etc/secondbrain-backup/vmid) names the container.
set -euo pipefail
vmid=${SB_VMID:-$(cat /etc/secondbrain-backup/vmid 2>/dev/null || true)}
[[ $vmid =~ ^[1-9][0-9]{2,8}$ ]] || { echo 'Set SB_VMID to the container id' >&2; exit 2; }
work=/var/lib/vz/secondbrain-backup
install -d -o root -g 100000 -m 0710 "$work"
case ${1:-} in
 capture)
  exec 9>/run/lock/secondbrain-offhost-backup.lock
  flock -n 9 || { echo 'Backup already running' >&2; exit 1; }
  log=$(mktemp "$work/capture-XXXXXXXX.log")
  if ! vzdump "$vmid" --dumpdir "$work" --mode suspend --compress zstd --remove 1 --prune-backups keep-last=2 >"$log" 2>&1; then
    echo "Container capture failed; inspect $log" >&2; exit 1
  fi
  archive=$(find "$work" -maxdepth 1 -type f -name "vzdump-lxc-$vmid-*.tar.zst" -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
  test -n "$archive"
  chmod 0600 "$archive" "$log"
  zstd -t -q "$archive"
  printf '%s\n' "$archive"
 ;;
 durable|full)
  archive=${2:?Missing archive}
  [[ $archive =~ ^/var/lib/vz/secondbrain-backup/vzdump-lxc-$vmid-[0-9_:-]+\.tar\.zst$ ]] || { echo 'Invalid backup path' >&2; exit 2; }
  [[ -f $archive && ! -L $archive && $(stat -c %u "$archive") == 0 ]] || exit 2
  if [[ $1 == durable ]]; then
    exec python3 /usr/local/lib/secondbrain-backup/export-snapshot.py "$archive"
  else
    exec cat -- "$archive"
  fi
 ;;
 success|failure|restored)
  action=$1
  if [[ $action != failure ]]; then [[ ${2:-} =~ ^[a-f0-9]{8,64}$ ]] || exit 2; fi
  pct exec "$vmid" -- install -d -o root -g secondbrain -m 0750 /var/lib/secondbrain-ops
  pct exec "$vmid" -- python3 - "$action" "${2:-}" </usr/local/lib/secondbrain-backup/state.py
 ;;
 *) echo 'Use capture, durable, full, success, failure or restored' >&2; exit 2 ;;
esac
