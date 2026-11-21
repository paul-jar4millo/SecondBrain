#!/usr/bin/env bash
# Instala el lanzador en el contenedor. Ejecutar como root con la versión ya
# desplegada en /opt/secondbrain/current. Idempotente; no toca el runner anterior
# (usa credenciales con otros nombres).
set -euo pipefail
release=${SB_RELEASE:-/opt/secondbrain/current}
src=$release/ops/lanzador
launcher=secondbrain-lanzador.service
summary=resumen-matutino.timer
if [[ -f /etc/secondbrain/english-layout ]]; then
  launcher=secondbrain-launcher.service
  summary=morning-summary.timer
fi
agente=/var/lib/sb-agente
servicio=/var/lib/secondbrain
install -d -m 750 -o root -g sb-agente /etc/sb-agente

# Credenciales: el servicio guarda el token de control; el lanzador solo su hash.
if [[ ! -s $servicio/lanzador-token ]]; then
  (umask 077; openssl rand -hex 32 | tr -d '\n' >"$servicio/lanzador-token")
  chown secondbrain:secondbrain "$servicio/lanzador-token"
fi
hash=/etc/sb-agente/lanzador-control.sha256
sha256sum <"$servicio/lanzador-token" | cut -d' ' -f1 >"$hash"
chown root:sb-agente "$hash"
chmod 0440 "$hash"

# Proyectos disponibles para los threads (carpetas de sb-agente, nunca el vault).
install -d -m 750 -o root -g sb-agente /etc/sb-agente
/opt/node/bin/node -e '
const fs = require("fs"), path = require("path");
const base = fs.realpathSync("/srv/sb-agente/proyectos");
let projects;
try {
  projects = JSON.parse(fs.readFileSync("/etc/sb-agente/proyectos.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  projects = {};
}
for (const e of fs.readdirSync(base, { withFileTypes: true }))
  if (e.isDirectory() && /^[a-z0-9_-]+$/i.test(e.name)) projects[e.name] ??= path.join(base, e.name);
fs.writeFileSync("/etc/sb-agente/proyectos.json", JSON.stringify(projects, null, 2));
'
chmod 644 /etc/sb-agente/proyectos.json
install -d -m 700 -o sb-agente -g sb-agente "$agente/estado/lanzador"

if [[ -f $release/ops/agents/install.mjs ]]; then
  /opt/node/bin/node "$release/ops/agents/install.mjs"
fi
/opt/node/bin/node "$src/configure-remote.mjs"
chown sb-agente:sb-agente "$agente/claude/settings.json" "$agente/deepseek/settings.json" "$agente/.gemini/config/hooks.json" "$agente/.gemini/antigravity-cli/settings.json"

# El servicio principal reenvía al lanzador por loopback.
install -d /etc/systemd/system/secondbrain.service.d
cat >/etc/systemd/system/secondbrain.service.d/lanzador.conf <<'EOF'
[Service]
Environment=LANZADOR_URL=http://127.0.0.1:8092
Environment=LANZADOR_TOKEN_FILE=/var/lib/secondbrain/lanzador-token
EOF

# Retired with the session-era chat (ADR 0010).
rm -f /usr/local/bin/sb-hilo "$agente/hook-token" /etc/sb-agente/hook-token.sha256

systemctl daemon-reload
systemctl enable "$launcher"
if [[ ${SB_ACTIVATE:-1} == 1 ]]; then
  systemctl start "$launcher"
  systemctl restart secondbrain.service
fi
if [[ ${SB_ENABLE_AUTOMATIONS:-0} == 1 ]]; then
  systemctl enable --now "$summary"
fi
echo "Launcher installed."
echo "Pendiente manual: token de GitHub, login de Claude y claude-sb-agente.service."
