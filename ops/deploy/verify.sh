#!/usr/bin/env bash
# Read-only verification of the active release.
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
release=${1:?Expected an active release directory}
launch=secondbrain-lanzador.service
[[ ! -f /etc/secondbrain/english-layout ]] || launch=secondbrain-launcher.service
systemctl is-active --quiet "$launch"
if [[ -f $release/image-reference ]]; then
  expected=$(<"$release/image-reference")
  systemctl is-active --quiet secondbrain-container.service
  tested=$(podman container inspect systemd-secondbrain-container --format '{{.ImageName}}')
  test "$expected" = "$tested"
else
  systemctl is-active --quiet secondbrain.service
fi
test "$(cat /run/secondbrain-launcher-release)" = "$release"
bash "$release/ops/deploy/check-drift.sh" "$release"
nft list ruleset | awk -v uid="$(id -u sb-agente)" 'index($0, "skuid " uid " ") { hit=1 } END { exit !hit }'
node --input-type=module - "$(cat "$release/REVISION")" <<'JS'
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
const revision = process.argv[2];
const token = (await readFile("/var/lib/secondbrain/lanzador-token", "utf8")).trim();
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const [health, launcher] = await Promise.all([
      fetch("http://127.0.0.1:8080/api/v1/health", { signal: AbortSignal.timeout(3000) }),
      fetch("http://127.0.0.1:8092/threads", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(3000),
      }),
    ]);
    const body = await health.json();
    const deployment = body.maintenance?.deployment;
    if (health.ok && body.status === "ready" &&
        deployment?.revision === revision && deployment?.launcherRevision === revision &&
        launcher.ok && Array.isArray((await launcher.json()).threads)) process.exit(0);
  } catch {
    // Startup can briefly refuse connections.
  }
  await setTimeout(1000);
}
throw new Error("Health or launcher revision does not match the deployment.");
JS
