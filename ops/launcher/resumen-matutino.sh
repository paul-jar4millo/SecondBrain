#!/usr/bin/env bash
# Pide al lanzador la sesión de Marina que escribe el resumen diario.
# Corre como el usuario del servicio: el token de control no es legible por sb-agente.
set -euo pipefail
puerto="${SB_LANZADOR_PORT:-8092}"
token="$(cat "${SB_CONTROL_TOKEN_FILE:-/var/lib/secondbrain/lanzador-token}")"
skill="${SB_SKILL_RESUMEN:-/opt/secondbrain/current/lanzador/skills/resumen-matutino.md}"
cuerpo="$(SB_BRIEF="$(cat "$skill")"$'\n\nHoy es '"$(TZ=America/Mexico_City date +%F)"'.' \
  /opt/node/bin/node -e 'console.log(JSON.stringify({motor:"deepseek",origen:"cron",proyecto:"general",brief:process.env.SB_BRIEF}))')"
curl -fsS --max-time 20 -X POST "http://127.0.0.1:${puerto}/sesiones" \
  -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' --data "$cuerpo"
