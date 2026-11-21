#!/usr/bin/env bash
# Dentro del LXC, como root. Comprueba que la instalación quedó como se espera.
# Solo lee y hace peticiones de prueba; no cambia nada. Sale con 1 si algo falla.
set -uo pipefail
aqui=$(cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=/dev/null
source "${SB_LXC_ENV:-$aqui/lxc.env}"
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
agente=/var/lib/sb-agente
fallos=0 avisos=0
ok() { printf '  ok     %s\n' "$1"; }
mal() { printf '  FALLA  %s\n' "$1"; fallos=$((fallos + 1)); }
aviso() { printf '  falta  %s\n' "$1"; avisos=$((avisos + 1)); }
probar() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
no_debe() { local d=$1; shift; if "$@" >/dev/null 2>&1; then mal "$d"; else ok "$d"; fi; }
como_agente() { runuser -u sb-agente -- env -C "$agente" HOME="$agente" "$@"; }

echo "Servicio"
probar "Node $NODE_VERSION" test "$(node -v)" = "v$NODE_VERSION"
probar "active release" bash /opt/secondbrain/current/ops/deploy/verify.sh "$(readlink -f /opt/secondbrain/current)"
if [[ -f /etc/secondbrain/english-layout ]]; then
  probar "launcher service" systemctl is-active --quiet secondbrain-launcher
else
  probar "launcher service" systemctl is-active --quiet secondbrain-lanzador
fi
probar "health local" curl -fsS --max-time 5 http://127.0.0.1:8080/api/v1/health
probar "release activa" test -f /opt/secondbrain/current/REVISION
probar "vault con Home.md" test -f /srv/secondbrain/vault/Home.md
probar "script matutino legible por el servicio" runuser -u secondbrain -- test -r /opt/secondbrain/current/ops/lanzador/resumen-matutino.sh
probar "API de threads del lanzador" sh -c 'curl -fsS --max-time 5 -H "Authorization: Bearer $(cat /var/lib/secondbrain/lanzador-token)" http://127.0.0.1:8092/threads'
no_debe "sb-hilo retirado (ADR 0010)" test -e /usr/local/bin/sb-hilo
if [[ -e $agente/estado/lanzador/sesiones.json ]]; then
  aviso "datos de sesiones antiguas (paso de datos de A9 pendiente)"
fi
probar "configuración operativa sin deriva" node /opt/secondbrain/current/ops/deploy/configure.mjs --release /opt/secondbrain/current --parameters /etc/secondbrain/parameters.json --check
probar "utilidad de homelab instalada" test -x /usr/local/bin/estado-pc
probar "gestor de usuario disponible" systemctl is-active --quiet "user@$(id -u sb-agente).service"
if [[ ${ACTIVAR_AUTOMATIZACIONES:-0} == 1 ]]; then
  probar "resumen matutino programado" systemctl is-enabled --quiet resumen-matutino.timer
fi
if [[ -n $HEALTH_PUBLICO ]]; then
  probar "HTTPS público" curl -fsS --max-time 8 "$HEALTH_PUBLICO"
fi
if [[ -n $REPO_VAULT && ${ACTIVAR_AUTOMATIZACIONES:-0} == 1 ]]; then
  probar "push del vault programado" systemctl is-enabled --quiet secondbrain-vault-push.timer
  probar "acceso de escritura al repo del vault" runuser -u secondbrain -- env -C /srv/secondbrain/vault \
    GIT_SSH_COMMAND="/usr/bin/ssh -F /dev/null -i /var/lib/secondbrain/vault-git/id_ed25519 -o UserKnownHostsFile=/var/lib/secondbrain/vault-git/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes" \
    git push --dry-run origin HEAD:main
fi

echo "Despliegue continuo"
if [[ -n $RUNNER_NOMBRE ]]; then
  if systemctl list-units --all --no-legend 'actions.runner.*' | grep -q running; then ok "runner de GitHub activo"
  else aviso "runner de GitHub (instalar.sh lo registra)"; fi
fi
probar "sudo limitado al helper" sudo -l -U sb-runner /usr/local/sbin/secondbrain-deploy x

echo "Aislamiento de sb-agente"
probar "reglas nftables cargadas" sh -c "nft list ruleset | grep -q 'skuid $(id -u sb-agente)'"
no_debe "la LAN (gateway $GATEWAY) está bloqueada" como_agente curl -fsS --max-time 4 "http://$GATEWAY"
no_debe "el proxy $PROXY_IP está bloqueado" como_agente curl -fsS --max-time 4 "http://$PROXY_IP"
probar "internet funciona" como_agente curl -fsS --max-time 8 -o /dev/null https://api.github.com
probar "DNS para las agentes" como_agente getent hosts github.com
no_debe "el vault es inaccesible para sb-agente" como_agente ls /srv/secondbrain/vault
no_debe "los datos del servicio son inaccesibles" como_agente cat /var/lib/secondbrain/agentes-brain-token

echo "Motores (cuentas: dentro/conectar.sh)"
probar "pinned agent CLIs" node /opt/secondbrain/current/ops/agents/install.mjs --check
[[ -s $agente/claude/.credentials.json ]] && ok "sesión de Claude" || aviso "sesión de Claude"
grep -q '^DEEPSEEK_API_KEY=.' "$agente/agentes.env" 2>/dev/null && ok "clave de DeepSeek" || aviso "clave de DeepSeek"
[[ -s $agente/codex/auth.json ]] && ok "sesión de Codex" || aviso "sesión de Codex"
[[ -x /opt/sb-agente/cli/current/bin/agy ]] && ok "Antigravity instalado" || aviso "Antigravity instalado"
[[ -s $agente/.gemini/antigravity-cli/antigravity-oauth-token ]] && ok "sesión de Antigravity" || aviso "sesión de Antigravity"
[[ -s $agente/.config/gh/hosts.yml ]] && ok "token de GitHub de las agentes" || aviso "token de GitHub de las agentes"
systemctl is-active --quiet claude-sb-agente.service && ok "Remote Control" || aviso "Remote Control"

echo
echo "Fallos: $fallos · Pendientes de cuentas: $avisos"
[[ $fallos == 0 ]]
