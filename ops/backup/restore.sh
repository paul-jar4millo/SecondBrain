#!/bin/sh
set -eu
: "${RESTIC_REPOSITORY:?Define el repositorio restic}"
: "${RESTIC_PASSWORD_FILE:?Define el archivo de clave restic}"
: "${RESTORE_DIR:?Define una carpeta de restauración vacía, separada del vault activo}"
[ ! -e "$RESTORE_DIR" ] || [ -z "$(ls -A "$RESTORE_DIR")" ]
mkdir -p "$RESTORE_DIR"
restic restore "${1:-latest}" --tag second-brain-vault --target "$RESTORE_DIR"
printf '%s\n' 'Copia restaurada en el directorio separado. Comprueba Markdown, adjuntos y autenticación antes de cambiar VAULT_ROOT.'
