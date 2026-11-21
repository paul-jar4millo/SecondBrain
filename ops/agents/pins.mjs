import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const exactVersion = /^\d+\.\d+\.\d+$/;

export function parsePins(manifest, pkg, lock) {
  const versions = {};
  for (const [id, expected, label] of [
    ["claude", "@anthropic-ai/claude-code", "Claude"],
    ["codex", "@openai/codex", "Codex"],
  ]) {
    const name = manifest[id]?.npmPackage;
    const version = pkg.dependencies?.[name];
    const entry = lock.packages?.["node_modules/" + name];
    if (
      name !== expected ||
      typeof version !== "string" ||
      !exactVersion.test(version) ||
      entry?.version !== version ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")
    )
      throw new Error(label + " package must be exactly locked with integrity");
    versions[id] = version;
  }
  const agy = manifest.agy;
  const artifact = agy?.linuxX64;
  if (
    typeof agy?.version !== "string" ||
    !exactVersion.test(agy.version) ||
    typeof artifact?.url !== "string" ||
    !/^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/[\d.-]+\/linux-x64\/cli_linux_x64\.tar\.gz$/.test(
      artifact.url,
    ) ||
    !artifact.url.includes("/" + agy.version + "-") ||
    !/^[a-f0-9]{128}$/.test(artifact.sha512 ?? "")
  )
    throw new Error("Invalid Antigravity Linux x64 pin");
  versions.agy = agy.version;
  return { versions, artifact };
}

export async function readPins() {
  const sources = await Promise.all(
    ["versions.json", "package.json", "package-lock.json"].map((name) =>
      readFile(new URL(name, import.meta.url), "utf8"),
    ),
  );
  const [manifest, pkg, lock] = sources.map((source) => JSON.parse(source));
  const digest = createHash("sha256")
    .update(JSON.stringify([manifest, pkg.dependencies, lock]))
    .digest("hex");
  return { ...parsePins(manifest, pkg, lock), digest };
}
