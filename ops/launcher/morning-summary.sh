#!/usr/bin/env bash
# Opens the scratch thread in which Marina writes the daily summary.
# Runs as the service user: sb-agente cannot read the control token.
set -euo pipefail
puerto="${SB_LAUNCHER_PORT:-8092}"
token="$(cat "${SB_CONTROL_TOKEN_FILE:-/var/lib/secondbrain/lanzador-token}")"
skill="${SB_SKILL_SUMMARY:-/opt/secondbrain/current/launcher/skills/resumen-matutino.md}"
hoy="$(TZ=America/Mexico_City date +%F)"
cuerpo="$(SB_PROMPT="$(cat "$skill")"$'\n\nHoy es '"$hoy"'.' SB_HOY="$hoy" \
  /opt/node/bin/node -e 'console.log(JSON.stringify({
    title: "Resumen matutino " + process.env.SB_HOY,
    prompt: process.env.SB_PROMPT,
    kind: "scratch",
    agent: { engine: "deepseek" },
  }))')"
curl -fsS --max-time 20 -X POST "http://127.0.0.1:${puerto}/threads" \
  -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' --data "$cuerpo"
