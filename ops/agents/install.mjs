import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify, parseArgs } from "node:util";
import { readPins } from "./pins.mjs";

const execute = promisify(execFile);
const {
  values: { prefix, check, manifest },
} = parseArgs({
  options: {
    prefix: { type: "string", default: "/opt/sb-agente/cli" },
    check: { type: "boolean" },
    manifest: { type: "boolean" },
  },
});

const { versions, artifact, digest } = await readPins();
if (manifest) {
  console.log(JSON.stringify(versions));
} else {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The pinned provider CLIs require Linux x64");
  // Operators may deploy with a restrictive umask. The launcher user must
  // be able to traverse the root-owned binary directories.
  if (!check) process.umask(0o022);
  await runInstaller(path.resolve(prefix));
}

async function verifyVersions(directory) {
  // Even --version runs without the operator's home or credentials.
  const home = await mkdtemp(path.join(tmpdir(), "sb-provider-versions-"));
  try {
    const env = {
      HOME: home,
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      XDG_CONFIG_HOME: home,
      PATH: process.env.PATH,
      NO_COLOR: "1",
    };
    for (const [name, version] of Object.entries(versions)) {
      const { stdout } = await execute(
        path.join(directory, "bin", name),
        ["--version"],
        { env, cwd: home, timeout: 15_000 },
      );
      if (!stdout.trim().split(/\s+/).includes(version))
        throw new Error(name + " does not report pinned version " + version);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function installAgy(directory) {
  const archive = path.join(directory, "agy.tar.gz");
  await execute("curl", [
    "-q",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--max-time",
    "180",
    "--output",
    archive,
    artifact.url,
  ]);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha512)
    throw new Error("Antigravity archive failed SHA-512 verification");

  const binary = path.join(directory, "bin/agy");
  // Copy the one known entry to a regular file. Tar never writes paths itself.
  const child = spawn("tar", ["-xOzf", archive, "antigravity"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(binary, { mode: 0o755 })),
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Antigravity extraction failed")),
      );
    }),
  ]);
  await rm(archive);
}

async function runInstaller(root) {
  const current = path.join(root, "current");
  const destination = path.join(root, digest);
  const active = await readlink(current).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (check || active === digest) {
    if (active !== digest)
      throw new Error("The active provider CLIs do not match this release");
    await verifyVersions(current);
    return;
  }

  await mkdir(root, { recursive: true, mode: 0o755 });
  const stage = await mkdtemp(path.join(root, ".install-"));
  try {
    if (
      !(await access(destination).then(
        () => true,
        () => false,
      ))
    ) {
      const target = path.join(stage, "clis");
      await mkdir(path.join(target, "bin"), { recursive: true, mode: 0o755 });
      for (const file of ["package.json", "package-lock.json"]) {
        await copyFile(new URL(file, import.meta.url), path.join(target, file));
      }
      await execute(
        "npm",
        [
          "ci",
          "--workspaces=false",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: target, timeout: 300_000 },
      );

      // npm installed the reviewed platform package. Do not execute Claude
      // Code's postinstall to copy the native executable into another package.
      await symlink(
        "../node_modules/@anthropic-ai/claude-code-linux-x64/claude",
        path.join(target, "bin/claude"),
      );
      await symlink(
        "../node_modules/.bin/codex",
        path.join(target, "bin/codex"),
      );
      await installAgy(target);
      await verifyVersions(target);
      try {
        await rename(target, destination);
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      }
    }
    await verifyVersions(destination);
    const link = path.join(stage, "current");
    await symlink(digest, link);
    await rename(link, current);
    console.log(JSON.stringify({ installed: versions, directory: current }));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
