import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Catches a runtime that still needs the dashboard or resolves paths from cwd.
test("el servicio y el MCP funcionan sin servir la interfaz y comparten las revisiones", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-modules-"));
  const vault = path.join(temp, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Inicio\n");
  const git = async (...args) =>
    (await promisify(execFile)("git", ["-C", vault, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Synthetic");
  await git("config", "user.email", "synthetic@localhost");
  await git("add", "Home.md");
  await git("commit", "-m", "Initial");
  const tokenFile = path.join(temp, "brain-token");
  await writeFile(tokenFile, "synthetic-modules-token");
  const service = fileURLToPath(
    new URL("../../service/index.mjs", import.meta.url),
  );
  const cli = fileURLToPath(
    new URL("../../mcp/brain-cli.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [service], {
    cwd: temp,
    env: {
      ...process.env,
      VAULT_ROOT: vault,
      DATA_DIR: path.join(temp, "data"),
      AGENTES_BRAIN_TOKEN_FILE: tokenFile,
      AUTH: "on",
      SERVE_DASHBOARD: "off",
      VAULT_GIT: "on",
      API_PORT: "0",
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error("Servicio sin respuesta: " + stderr)),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("El servicio no arrancó: " + stderr));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
  });
  const health = await fetch(base + "/api/v1/health");
  assert.equal(health.status, 200);
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal((await health.json()).version, version);
  assert.equal((await fetch(base + "/")).status, 404);
  const call = async (tool, args) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, tool, JSON.stringify(args)],
      {
        cwd: temp,
        env: {
          ...process.env,
          SB_BRAIN_URL: base + "/api/v1",
          SB_BRAIN_TOKEN_FILE: tokenFile,
        },
      },
    );
    return JSON.parse(stdout);
  };
  const before = await call("brain_read", { path: "Home.md" });
  await call("brain_write", {
    path: "Home.md",
    content: "# Editado\n",
    expectedHash: before.hash,
  });
  const response = await fetch(base + "/api/v1/vault/note?path=Home.md", {
    headers: { Authorization: "Bearer synthetic-modules-token" },
  });
  assert.equal((await response.json()).content, "# Editado\n");
  assert.equal(await git("show", "HEAD:Home.md"), "# Editado");
  await assert.rejects(
    call("brain_write", {
      path: "Home.md",
      content: "obsoleto",
      expectedHash: before.hash,
    }),
    /409/,
  );
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
});
