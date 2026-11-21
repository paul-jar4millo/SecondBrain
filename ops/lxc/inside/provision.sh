#!/usr/bin/env bash
# Dentro del LXC, como root. Deja SecondBrain listo a partir de un Debian 13 limpio.
# Idempotente: cada etapa se puede repetir. No pide ni imprime secretos de terceros.
#
#   provision.sh base            paquetes, Node, usuarios, unidades, nftables, CLIs
#   provision.sh vault           clona el vault (o crea uno mínimo si REPO_VAULT está vacío)
#   provision.sh desplegar SHA   activa release.tar.gz con el helper e instala el lanzador
#   provision.sh runner          registra el runner de GitHub; lee el token de registro por stdin
set -euo pipefail
aqui=$(cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=/dev/null
source "${SB_LXC_ENV:-$aqui/lxc.env}"
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

agente=/var/lib/sb-agente
servicio=/var/lib/secondbrain
vault=/srv/secondbrain/vault
clave_vault=$servicio/vault-git/id_ed25519
ssh_vault="/usr/bin/ssh -F /dev/null -i $clave_vault -o UserKnownHostsFile=$servicio/vault-git/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes"

paso() { printf '\n== %s\n' "$*"; }
como() { local u=$1; shift; runuser -u "$u" -- "$@"; }
como_agente() { runuser -u sb-agente -- env -C "$agente" HOME="$agente" PATH="/opt/sb-agente/cli/current/bin:/opt/sb-agente/node_modules/.bin:/opt/node/bin:/usr/bin:/bin:$agente/.local/bin" "$@"; }
plantilla() { sed -e "s|@PROXY_IP@|$PROXY_IP|g" "$aqui/templates/$1"; }

base() {
  paso "Paquetes del sistema"
  apt-get update -qq
  apt-get upgrade -y -qq >/dev/null
  apt-get install -y -qq ca-certificates curl git nftables sudo python3 openssl xz-utils \
    bubblewrap procps gh openssh-client restic podman >/dev/null
  echo 'LANG=C.UTF-8' >/etc/default/locale
  timedatectl set-timezone "$ZONA" 2>/dev/null || ln -sfn "/usr/share/zoneinfo/$ZONA" /etc/localtime

  paso "Node $NODE_VERSION"
  if [[ $(/opt/node/bin/node -v 2>/dev/null) != "v$NODE_VERSION" ]]; then
    local tmp; tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
    echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum --check --status
    rm -rf /opt/node && mkdir -p /opt/node
    tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1 --no-same-owner
    rm -rf "$tmp"
  fi
  ln -sfn /opt/node/bin/node /usr/local/bin/node
  ln -sfn /opt/node/bin/npm /usr/local/bin/npm

  paso "Usuarios y carpetas"
  id secondbrain >/dev/null 2>&1 || useradd --system --home-dir "$servicio" --shell /usr/sbin/nologin secondbrain
  id sb-agente >/dev/null 2>&1 || useradd --system --home-dir "$agente" --shell /usr/sbin/nologin sb-agente
  id sb-runner >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/sb-runner --shell /bin/bash sb-runner
  install -d -m 700 -o secondbrain -g secondbrain "$servicio" "$servicio/vault-git"
  install -d -m 750 -o root -g secondbrain /var/lib/secondbrain-ops
  install -d -m 700 -o secondbrain -g secondbrain /srv/secondbrain
  install -d -m 700 -o sb-agente -g sb-agente "$agente" "$agente/claude" "$agente/deepseek" \
    "$agente/codex" "$agente/.local" "$agente/.local/bin" "$agente/.gemini" "$agente/.gemini/config"
  install -d -m 750 -o sb-agente -g sb-agente /srv/sb-agent /srv/sb-agent/projects
  install -d -m 700 -o sb-agente -g sb-agente /srv/sb-agent/projects/general
  install -d -m 700 -o sb-agente -g sb-agente /srv/sb-agent/projects/SecondBrain /srv/sb-agent/projects/sb-agente /srv/sb-agent/deliverables
  install -d -m 755 /opt/secondbrain /opt/secondbrain/releases /opt/sb-agente /etc/secondbrain
  install -d -m 755 -o sb-runner -g sb-runner /var/lib/sb-runner/incoming
  [[ -f $agente/agentes.env ]] || install -m 600 -o sb-agente -g sb-agente /dev/null "$agente/agentes.env"

  paso "Credencial de las agentes para el vault"
  if [[ ! -s $agente/brain-token ]]; then
    (umask 077; openssl rand -base64 32 | tr -d '\n' >"$agente/brain-token")
    chown sb-agente:sb-agente "$agente/brain-token"
  fi
  install -m 600 -o secondbrain -g secondbrain "$agente/brain-token" "$servicio/agentes-brain-token"

  paso "Llave de despliegue del vault"
  if [[ ! -f $clave_vault ]]; then
    como secondbrain ssh-keygen -q -t ed25519 -N '' -C "secondbrain-vault@$NOMBRE" -f "$clave_vault"
  fi
  # Llaves de host publicadas por GitHub (por HTTPS), no aceptadas a ciegas.
  curl -fsSL https://api.github.com/meta |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const k of JSON.parse(s).ssh_keys)console.log("github.com "+k)})' \
    >"$servicio/vault-git/known_hosts"
  chown secondbrain:secondbrain "$servicio/vault-git/known_hosts"

  paso "Configuración operativa completa"
  install -d -m 700 "$aqui/operational"
  tar -xzf "$aqui/release.tar.gz" --no-same-owner -C "$aqui/operational"
  PROXY_IP="$PROXY_IP" GATEWAY="$GATEWAY" AGENTE_UID="$(id -u sb-agente)" \
    PC_IP="${PC_IP:?Set PC_IP in lxc.env}" PC_MAC="${PC_MAC:?Set PC_MAC in lxc.env}" PC_BROADCAST="${PC_BROADCAST:?Set PC_BROADCAST in lxc.env}" \
    REMOTE_WORKDIR="${REMOTE_WORKDIR:-/srv/sb-agent/projects/sb-agente}" \
    node -e 'const f=require("fs"),e=process.env;f.writeFileSync("/etc/secondbrain/parameters.json",JSON.stringify({proxy:e.PROXY_IP,gateway:e.GATEWAY,agentUid:Number(e.AGENTE_UID),pc:e.PC_IP,mac:e.PC_MAC,broadcast:e.PC_BROADCAST,remoteWorkdir:e.REMOTE_WORKDIR},null,2),{mode:0o600})'
  node "$aqui/operational/ops/deploy/configure.mjs" --release "$aqui/operational" --parameters /etc/secondbrain/parameters.json
  printf 'PROXY_IP=%q\nGATEWAY=%q\nAGENTE_UID=%q\n' "$PROXY_IP" "$GATEWAY" "$(id -u sb-agente)" >/etc/secondbrain/ops.env
  chmod 600 /etc/secondbrain/ops.env
  systemctl daemon-reload
  systemctl enable secondbrain.service >/dev/null

  paso "Helper de despliegue y MCP"
  printf '%s\n' "$HEALTH_PUBLICO" >/etc/secondbrain/health-url
  printf 'ghcr.io/%s\n' "${REPO_APP,,}" >/etc/secondbrain/image-repository
  echo 'sb-runner ALL=(root) NOPASSWD: /usr/local/sbin/secondbrain-deploy *' >/etc/sudoers.d/secondbrain-deploy
  chmod 440 /etc/sudoers.d/secondbrain-deploy
  visudo -cq
  cat >/usr/local/bin/secondbrain-mcp <<'EOF'
#!/bin/sh
set -eu
cd /opt/secondbrain/current
export DATA_DIR=/var/lib/secondbrain
exec /opt/node/bin/node server/mcp.mjs
EOF
  chmod 755 /usr/local/bin/secondbrain-mcp

  paso "Aislamiento de red de sb-agente (nftables)"
  nft -c -f /etc/nftables.conf
  systemctl enable --now nftables.service >/dev/null
  systemctl restart nftables.service
  install -d -m 750 -o root -g sb-agente /etc/sb-agente
  printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' >/etc/sb-agente/resolv.conf
  chmod 644 /etc/sb-agente/resolv.conf

  paso "Install pinned agent CLIs"
  node "$aqui/operational/ops/agents/install.mjs"
  # User scopes need a real user manager; no provider is started by linger.
  loginctl enable-linger sb-agente
  systemctl start "user@$(id -u sb-agente).service"

  paso "Configuración de los motores (MCP secondbrain)"
  local settings='{}'
  local mcp='{"type":"stdio","command":"/opt/node/bin/node","args":["/opt/secondbrain/current/server/mcp.mjs"],"env":{"SB_BRAIN_TOKEN_FILE":"${SB_BRAIN_TOKEN_FILE}","SB_BRAIN_URL":"${SB_BRAIN_URL}","SB_AGENT":"${SB_AGENT}","SB_SESSION_ID":"${SB_SESSION_ID}"}}'
  for dir in claude deepseek; do
    printf '%s\n' "$settings" >"$agente/$dir/settings.json"
    chown sb-agente:sb-agente "$agente/$dir/settings.json"
    como_agente env CLAUDE_CONFIG_DIR="$agente/$dir" claude mcp remove secondbrain -s user >/dev/null 2>&1 || true
    como_agente env CLAUDE_CONFIG_DIR="$agente/$dir" claude mcp add-json secondbrain "$mcp" --scope user >/dev/null
  done
  cat >"$agente/codex/config.toml" <<'EOF'
[mcp_servers.secondbrain]
command = "/opt/node/bin/node"
args = ["/opt/secondbrain/current/server/mcp.mjs"]
tool_timeout_sec = 1900
startup_timeout_sec = 30
EOF
  cat >"$agente/.gemini/config/mcp_config.json" <<EOF
{
  "mcpServers": {
    "secondbrain": {
      "command": "/opt/node/bin/node",
      "args": ["/opt/secondbrain/current/server/mcp.mjs"],
      "disabled": false,
      "env": {
        "SB_AGENT": "lira",
        "SB_BRAIN_URL": "http://127.0.0.1:8080/api/v1",
        "SB_BRAIN_TOKEN_FILE": "$agente/brain-token"
      }
    }
  }
}
EOF
  chown sb-agente:sb-agente "$agente/codex/config.toml" "$agente/.gemini/config/mcp_config.json"
  chmod 600 "$agente/codex/config.toml" "$agente/.gemini/config/mcp_config.json"

  paso "Contexto de homelab de sb-agente"
  d=/srv/sb-agent/projects/sb-agente
  install -d -m 700 -o sb-agente -g sb-agente "$d" "$d/.claude"
  install -o sb-agente -g sb-agente -m 600 "$aqui/operational/ops/homelab/agent-context.md" "$d/CLAUDE.md"
  printf '%s\n' '{"permissions":{"allow":["Bash(pc-wake)","Bash(pc-status)"]}}' >"$d/.claude/settings.json"
  chown sb-agente:sb-agente "$d/.claude/settings.json"
  chmod 600 "$d/.claude/settings.json"
  # Prepare credentials and units before the first release without starting models.
  SB_RELEASE="$aqui/operational" SB_ACTIVATE=0 SB_ENABLE_AUTOMATIONS=0 bash "$aqui/operational/ops/launcher/install.sh"
  node "$aqui/operational/ops/deploy/configure.mjs" --release "$aqui/operational" --parameters /etc/secondbrain/parameters.json
  systemctl daemon-reload
  systemctl restart systemd-journald
  # Administration uses SSH to the container host + pct; no LXC password listener is needed.
  for unit in ssh.socket ssh.service postfix.service; do
    if systemctl cat "$unit" >/dev/null 2>&1; then systemctl disable --now "$unit" >/dev/null; fi
  done

  paso "Base lista"
  echo "Llave pública del vault (agregar como deploy key con escritura en $REPO_VAULT):"
  cat "$clave_vault.pub"
}

vault() {
  if [[ -d $vault/.git || -f $vault/Home.md ]]; then
    echo "El vault ya existe en $vault; no se toca."
  elif [[ -z $REPO_VAULT ]]; then
    paso "Vault mínimo de prueba (REPO_VAULT vacío)"
    install -d -m 700 -o secondbrain -g secondbrain "$vault" "$vault/00-Inbox"
    printf '# Home\n\nVault de prueba creado por provision.sh.\n' >"$vault/Home.md"
    chown secondbrain:secondbrain "$vault/Home.md"
    como secondbrain git -C "$vault" init -q -b main
  else
    paso "Clonando $REPO_VAULT"
    como secondbrain env GIT_SSH_COMMAND="$ssh_vault" git clone -q "git@github.com:$REPO_VAULT.git" "$vault"
  fi
  como secondbrain git -C "$vault" config user.name SecondBrain
  como secondbrain git -C "$vault" config user.email secondbrain@localhost
  if [[ -n $REPO_VAULT && ${ENABLE_AUTOMATIONS:-${ENABLE_AUTOMATIONS:-0}} == 1 ]]; then
    systemctl enable --now secondbrain-vault-push.timer >/dev/null
  else
    systemctl disable --now secondbrain-vault-push.timer >/dev/null 2>&1 || true
  fi
  test -f "$vault/Home.md"
  echo "Vault listo."
}

desplegar() {
  local sha=${1:?Falta el SHA de la release}
  [[ $sha =~ ^[a-f0-9]{40}$ ]] || { echo "SHA inválido" >&2; exit 2; }
  test -f "$vault/Home.md" || { echo "Primero: provision.sh vault" >&2; exit 1; }
  paso "Activando la release $sha"
  if [[ $(cat /opt/secondbrain/current/REVISION 2>/dev/null) != "$sha" ]]; then
    install -d -o sb-runner -g sb-runner "/var/lib/sb-runner/incoming/$sha"
    install -m 644 -o sb-runner -g sb-runner "$aqui/release.tar.gz" "/var/lib/sb-runner/incoming/$sha/release.tar.gz"
    /usr/local/sbin/secondbrain-deploy "$sha"
    rm -rf -- "/var/lib/sb-runner/incoming/$sha"
  fi
  paso "Lanzador"
  SB_ENABLE_AUTOMATIONS="${ENABLE_AUTOMATIONS:-${ENABLE_AUTOMATIONS:-0}}" bash /opt/secondbrain/current/ops/launcher/install.sh
  node /opt/secondbrain/current/ops/deploy/configure.mjs --release /opt/secondbrain/current --parameters /etc/secondbrain/parameters.json
  systemctl daemon-reload
}

runner() {
  [[ -n $RUNNER_NOMBRE ]] || { echo "RUNNER_NOMBRE vacío: no se registra runner."; exit 0; }
  local token; read -r token
  [[ -n $token ]] || { echo "Falta el token de registro por stdin." >&2; exit 2; }
  paso "Runner de GitHub $RUNNER_VERSION"
  local dir=/opt/actions-runner
  if [[ ! -x $dir/config.sh ]]; then
    local tmp; tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/runner.tgz" \
      "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
    echo "$RUNNER_SHA256  $tmp/runner.tgz" | sha256sum --check --status
    install -d -o sb-runner -g sb-runner "$dir"
    tar -xzf "$tmp/runner.tgz" -C "$dir" --no-same-owner
    chown -R sb-runner:sb-runner "$dir"
    rm -rf "$tmp"
    "$dir/bin/installdependencies.sh" >/dev/null
  fi
  if [[ ! -f $dir/.runner ]]; then
    (cd "$dir" && runuser -u sb-runner -- ./config.sh --unattended --replace \
      --url "https://github.com/$REPO_APP" --token "$token" \
      --name "$RUNNER_NOMBRE" --labels "$RUNNER_ETIQUETA" --work _work)
  fi
  (cd "$dir" && { ./svc.sh status >/dev/null 2>&1 && ./svc.sh status | grep -q 'active (running)'; } ||
    { ./svc.sh install sb-runner >/dev/null 2>&1 || true; ./svc.sh start; })
  echo "Runner registrado como $RUNNER_NOMBRE."
}

case ${1:-} in
  base) base ;;
  vault) vault ;;
  desplegar) desplegar "${2:-}" ;;
  runner) runner ;;
  *) sed -n '2,9p' "$0" >&2; exit 2 ;;
esac
