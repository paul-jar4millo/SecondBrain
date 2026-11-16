#!/bin/sh
exec sh "$(dirname "$0")/../../ops/backup/restore.sh" "$@"
