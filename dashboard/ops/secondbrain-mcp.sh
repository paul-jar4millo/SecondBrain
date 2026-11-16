#!/bin/sh
set -eu
cd /opt/secondbrain/current
export DATA_DIR=/var/lib/secondbrain
exec /opt/node/bin/node server/mcp.mjs
