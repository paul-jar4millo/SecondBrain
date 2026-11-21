#!/usr/bin/env bash
# Dentro del LXC, como root y en una terminal interactiva (ssh -t <host> pct enter <VMID>).
# Conecta las cuentas del dueño: lo único que no se puede automatizar.
# Cada paso pregunta antes y se puede repetir; las claves se escriben sin mostrarse.
#
#   bash /root/sb-lxc/inside/connect.sh            todos los pasos
#   bash /root/sb-lxc/inside/connect.sh claude     solo uno: claude | deepseek | codex | agy | github | remote
set -euo pipefail
agente=/var/lib/sb-agente
env_file=$agente/agentes.env
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# shellcheck source=/dev/null
source "${SB_LXC_ENV:-$(dirname "$0")/../lxc.env}"

como_agente() {
  runuser -u sb-agente -- env -C /srv/sb-agent/projects HOME="$agente" LANG=C.UTF-8 \
    PATH="/opt/sb-agente/cli/current/bin:/opt/sb-agente/node_modules/.bin:/opt/node/bin:/usr/bin:/bin:$agente/.local/bin" "$@"
}
# Algunos CLIs necesitan una TTY propia aunque runuser no la asigne.
tty_agente() { como_agente script -qfc "$(printf '%q ' "$@")" /dev/null; }
pregunta() { local r; read -rp "$1 [s/N] " r; [[ $r =~ ^[sS]$ ]]; }
poner_env() { # poner_env NOMBRE: lee el valor sin eco y lo guarda en agentes.env
  local valor; read -rsp "$1: " valor; echo
  [[ -n $valor ]] || { echo "Vacío; no se cambió."; return; }
  touch "$env_file"
  grep -v "^$1=" "$env_file" >"$env_file.tmp" || true
  printf '%s=%s\n' "$1" "$valor" >>"$env_file.tmp"
  install -m 600 -o sb-agente -g sb-agente "$env_file.tmp" "$env_file"
  rm -f "$env_file.tmp"
}

claude() {
  echo "Ámbar (Claude) y Remote Control. Se abre Claude Code: escribe /login, sigue el enlace y luego /exit."
  pregunta "¿Iniciar sesión de Claude?" || return 0
  tty_agente env CLAUDE_CONFIG_DIR="$agente/claude" claude
}
deepseek() {
  echo "Marina (DeepSeek por API). Pega la clave de https://platform.deepseek.com/api_keys"
  pregunta "¿Guardar la clave de DeepSeek?" || return 0
  poner_env DEEPSEEK_API_KEY
}
codex() {
  echo "Menta (Codex). Se mostrará un código para https://auth.openai.com/codex/device"
  pregunta "¿Iniciar sesión de Codex?" || return 0
  tty_agente env CODEX_HOME="$agente/codex" codex login --device-auth
}
agy() {
  echo "Lira (Antigravity). Si falta, se instala con el instalador oficial en ~/.local/bin de sb-agente."
  pregunta "¿Instalar o conectar Antigravity?" || return 0
  if [[ ! -x /opt/sb-agente/cli/current/bin/agy ]]; then
    como_agente bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  fi
  como_agente agy --version
  echo "Se abre agy: elige Google OAuth, abre la URL, pega el código y sal con /exit."
  tty_agente agy
}
github() {
  echo "GitHub para las agentes: les deja clonar repositorios, empujar ramas y abrir PR."
  echo "Token fino con Contents y Pull requests (lectura y escritura). Créalo en"
  echo "https://github.com/settings/personal-access-tokens/new. Se configura una sola vez:"
  echo "para dar acceso a otro repo se edita el mismo token; no hay que volver a pegarlo."
  pregunta "¿Guardar el token y clonar SecondBrain?" || return 0
  local token; read -rsp "Token: " token; echo
  [[ -n $token ]] || { echo "Vacío; no se cambió."; return; }
  printf '%s\n' "$token" | como_agente gh auth login --hostname github.com --git-protocol https --with-token
  unset token
  como_agente gh auth setup-git
  como_agente git config --global user.name "${AGENT_GIT_NAME:-SecondBrain agents}"
  como_agente git config --global user.email "${AGENT_GIT_EMAIL:-agents@secondbrain.invalid}"
  local destino=/srv/sb-agent/projects/SecondBrain
  if [[ -d $destino/.git ]]; then echo "SecondBrain ya clonado."
  else como_agente rm -rf "$destino"; como_agente gh repo clone "${REPO_APP:?}" "$destino" -- -q; fi
  # Regenera la lista de proyectos del lanzador con las carpetas nuevas.
  bash /opt/secondbrain/current/ops/launcher/install.sh >/dev/null
}
remote() {
  echo "Remote Control: deja una sesión de Claude del LXC disponible en la app del celular."
  pregunta "¿Activar claude-sb-agente.service?" || return 0
  systemctl enable --now claude-sb-agente.service
  systemctl --no-pager --lines=5 status claude-sb-agente.service || true
}

pasos=${1:-claude deepseek codex agy github remote}
for p in $pasos; do
  case $p in claude|deepseek|codex|agy|github|remote) printf '\n== %s\n' "$p"; "$p" ;;
    *) echo "Paso desconocido: $p" >&2; exit 2 ;; esac
done
systemctl restart secondbrain-launcher.service
echo
echo "Listo. Comprueba todo con: bash /root/sb-lxc/inside/verify.sh"
