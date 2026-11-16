#!/bin/sh
# Compatibility entrypoint; operational sources live in ops/backup.
exec sh "$(dirname "$0")/../../ops/backup/backup.sh" "$@"
