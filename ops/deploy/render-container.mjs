import { isIP } from "node:net";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** @param {{image: string, repository: string, proxy: string, uid: number, gid: number}} settings */
export function renderContainer({ image, repository, proxy, uid, gid }) {
  if (
    !/^ghcr\.io\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository) ||
    !image.startsWith(repository + "@sha256:") ||
    !/^[a-f0-9]{64}$/.test(image.slice(repository.length + 8))
  )
    throw new Error(
      "Expected an immutable image digest in the configured registry repository.",
    );
  if (
    isIP(proxy) !== 4 ||
    ![uid, gid].every((id) => Number.isInteger(id) && id > 0 && id < 65535)
  )
    throw new Error("Invalid service identity or proxy address.");
  return [
    "[Unit]",
    "Description=SecondBrain service, dashboard and MCP",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Container]",
    "Image=" + image,
    "Pull=never",
    "Network=host",
    "User=" + uid + ":" + gid,
    "ReadOnly=true",
    "NoNewPrivileges=true",
    "DropCapability=ALL",
    "Environment=AUTH=on NODE_ENV=production HOST=0.0.0.0 PORT=8080",
    "Environment=TRUSTED_PROXY=" + proxy,
    "Environment=VAULT_GIT=on VAULT_ROOT=/srv/secondbrain/vault DATA_DIR=/var/lib/secondbrain",
    "Environment=AGENTES_BRAIN_TOKEN_FILE=/var/lib/secondbrain/agentes-brain-token",
    "Environment=SB_LAUNCHER_URL=http://127.0.0.1:8092 SB_LAUNCHER_TOKEN_FILE=/var/lib/secondbrain/lanzador-token",
    "Volume=/srv/secondbrain/vault:/srv/secondbrain/vault:rw",
    "Volume=/var/lib/secondbrain:/var/lib/secondbrain:rw",
    "Volume=/var/lib/secondbrain-ops:/var/lib/secondbrain-ops:ro",
    "Volume=/run/secondbrain-launcher-release:/run/secondbrain-launcher-release:ro",
    "",
    "[Service]",
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStartSec=180",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
) {
  const [, , imageFile, parametersFile, repositoryFile, uid, gid] =
    process.argv;
  const [image, parameters, repository] = await Promise.all(
    [imageFile, parametersFile, repositoryFile].map((file) =>
      readFile(file, "utf8"),
    ),
  );
  process.stdout.write(
    renderContainer({
      image: image.trim(),
      repository: repository.trim(),
      proxy: JSON.parse(parameters).proxy,
      uid: Number(uid),
      gid: Number(gid),
    }),
  );
}
