#!/bin/sh
# Sends a failure notice for one systemd unit to the endpoint in AVISO_URL.
# Started by secondbrain-aviso@.service (OnFailure=); never run by hand with secrets.
#
# Environment (from /etc/secondbrain/aviso.env, optional):
#   AVISO_URL      endpoint, e.g. a self-hosted ntfy topic or a generic webhook.
#   AVISO_FORMATO  "ntfy" (default: plain-text body + Title/Priority headers) or
#                  "json" (POST {"text": "..."}; fits Mattermost/Discord-like hooks).
# Without AVISO_URL it exits successfully and does nothing. The notice carries only
# the unit name and host name: no note contents, logs or credentials.
set -eu

unit=${1:-}
case $unit in
  '' | *[!A-Za-z0-9@:_.-]*)
    echo 'Nombre de unidad inválido.' >&2
    exit 2
    ;;
esac

[ -n "${AVISO_URL:-}" ] || exit 0

host=$(hostname 2>/dev/null || echo secondbrain)
mensaje="Falló $unit en $host. Revisar: journalctl -u $unit -n 50"

if [ "${AVISO_FORMATO:-ntfy}" = json ]; then
  curl -fsS --max-time 15 -H 'Content-Type: application/json' \
    --data "{\"text\":\"SecondBrain: $mensaje\"}" -- "$AVISO_URL" >/dev/null
else
  curl -fsS --max-time 15 -H 'Title: SecondBrain: unidad fallida' -H 'Priority: high' \
    -H 'Tags: warning' --data "$mensaje" -- "$AVISO_URL" >/dev/null
fi
echo "Aviso enviado por $unit."
