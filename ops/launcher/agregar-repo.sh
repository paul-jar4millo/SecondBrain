#!/usr/bin/env bash
# Adds a GitHub repository to the launcher and optionally links it to a project.
# Run inside the LXC as root:
#   bash /opt/secondbrain/current/ops/lanzador/agregar-repo.sh <owner/repo> [project-id]
# Idempotent. Refuses to restart the launcher while a thread is working, because that
# would interrupt it. Access comes from sb-agente's GitHub token: edit that token's
# repository access on GitHub; this script never reads or replaces it.
set -euo pipefail

repo=${1:-}
proyecto=${2:-}
if [[ ! $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_-]+$ ]]; then
  echo "Uso: agregar-repo.sh <dueño/repo> [proyecto-id]" >&2
  exit 2
fi
if [[ -n $proyecto && ! $proyecto =~ ^[a-zA-Z0-9_-]{1,100}$ ]]; then
  echo "Proyecto inválido: $proyecto" >&2
  exit 2
fi

nombre=${repo#*/}
agente=/var/lib/sb-agente
base=/srv/sb-agente/proyectos
destino=$base/$nombre
registro=/etc/sb-agente/proyectos.json
espacios=$agente/estado/lanzador/espacios.json
node=/opt/node/bin/node

# Restarting the launcher stops running turns; ask it which threads are busy.
activas=$(
  curl -fsS --max-time 5 -H "Authorization: Bearer $(cat /var/lib/secondbrain/lanzador-token)" \
    'http://127.0.0.1:8092/threads?status=setting-up,running,closing' |
    "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).threads.length))'
) || { echo "El lanzador no respondió; no se puede saber si hay turnos en curso." >&2; exit 1; }
if [[ $activas != 0 ]]; then
  echo "Hay $activas threads trabajando; reiniciar el lanzador los interrumpiría. Vuelve a ejecutarlo al terminar." >&2
  exit 1
fi

if [[ -e $destino/.git ]]; then
  echo "$nombre ya está clonado."
else
  [[ ! -e $destino ]] || { echo "$destino existe y no es un repositorio." >&2; exit 1; }
  echo "Clonando $repo; un repo grande puede tardar varios minutos..."
  if ! runuser -u sb-agente -- env -C "$base" HOME="$agente" PATH=/opt/node/bin:/usr/bin:/bin \
    gh repo clone "$repo" "$destino" -- --progress; then
    echo "No se pudo clonar $repo. Si el token no tiene acceso, añádelo en" >&2
    echo "https://github.com/settings/personal-access-tokens (Edit > Repository access)." >&2
    exit 1
  fi
fi

systemctl stop secondbrain-lanzador.service
trap 'systemctl start secondbrain-lanzador.service' EXIT

"$node" -e '
  const fs = require("fs");
  const [archivo, nombre, destino] = process.argv.slice(1);
  const lista = JSON.parse(fs.readFileSync(archivo, "utf8"));
  lista[nombre] = destino;
  fs.writeFileSync(archivo + ".tmp", JSON.stringify(lista, null, 2));
  fs.renameSync(archivo + ".tmp", archivo);
' "$registro" "$nombre" "$destino"
chmod 644 "$registro"

if [[ -n $proyecto ]]; then
  # Same document and revision bump as the launcher workspace registry; the launcher is stopped.
  runuser -u sb-agente -- "$node" -e '
    const fs = require("fs");
    const [archivo, id, nombre] = process.argv.slice(1);
    let estado = { revision: 0, vinculos: {} };
    try { estado = JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    estado.revision += 1;
    const links = estado.vinculos ?? estado.links ?? {};
    links[id] = nombre;
    estado.links = links;
    if (process.env.SB_LEGACY_HTTP_ROUTES !== "off" && Object.hasOwn(estado, "vinculos")) estado.vinculos = links;
    else delete estado.vinculos;
    fs.writeFileSync(archivo + ".tmp", JSON.stringify(estado));
    fs.renameSync(archivo + ".tmp", archivo);
  ' "$espacios" "$proyecto" "$nombre"
fi

trap - EXIT
systemctl start secondbrain-lanzador.service
echo "Listo: $repo disponible${proyecto:+ y vinculado a $proyecto}. Los threads nuevos lo usan; los abiertos conservan su worktree."
