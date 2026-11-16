#!/usr/bin/env bash
# En el host Proxmox VE, como root: crea el LXC descrito en lxc.env y lo arranca.
# No borra nada: si el VMID ya existe, se detiene.
set -euo pipefail
conf=${1:?Uso: crear-lxc.sh <lxc.env>}
# shellcheck source=/dev/null
source "$conf"
[[ $VMID =~ ^[1-9][0-9]{2,8}$ ]] || { echo 'VMID inválido' >&2; exit 2; }

if pct status "$VMID" >/dev/null 2>&1; then
  echo "El LXC $VMID ya existe. Bórralo a mano (pct destroy $VMID) o usa otro VMID." >&2
  exit 1
fi

if ! pveam list "$ALMACEN" | grep -q "$PLANTILLA"; then
  pveam update >/dev/null
  pveam download "$ALMACEN" "$PLANTILLA"
fi

pct create "$VMID" "$ALMACEN:vztmpl/$PLANTILLA" \
  --hostname "$NOMBRE" \
  --unprivileged 1 \
  --features nesting=1 \
  --cores "$CPU" --memory "$MEMORIA_MB" --swap "$SWAP_MB" \
  --rootfs "$ALMACEN:$DISCO_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$IP,gw=$GATEWAY,type=veth" \
  --nameserver "$GATEWAY" \
  --timezone "$ZONA" \
  --onboot "${ONBOOT:-1}" \
  --ostype debian
pct start "$VMID"

# Espera red antes de aprovisionar.
for _ in $(seq 1 30); do
  pct exec "$VMID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$VMID" -- getent hosts deb.debian.org >/dev/null
echo "LXC $VMID ($NOMBRE) creado y en marcha."
