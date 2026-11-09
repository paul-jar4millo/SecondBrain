import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vault, hash, actorContext } from "../vault.mjs";

const exec = promisify(execFile);

// Catches missing commits, committing rollback contents or exposing ignored credentials.
test("el vault versiona una transacción completa sin incluir secretos ni operaciones fallidas", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) =>
    (await exec("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Synthetic");
  await git("config", "user.email", "synthetic@localhost");
  await writeFile(
    path.join(root, ".gitignore"),
    ".env\n.second-brain-runtime/\n",
  );
  await writeFile(path.join(root, ".env"), "secret");
  await writeFile(path.join(root, "Home.md"), "# Inicial\n");
  await mkdir(path.join(root, "00-Inbox"));
  await git("add", "--all");
  await git("commit", "-m", "Initial");
  const { GitHistory } = await import("../vault-git.mjs");
  const vault = new Vault(root, undefined, {
    versioning: new GitHistory(root),
  });
  await actorContext.run("mcp", () =>
    vault.exclusive(() =>
      vault.transaction(async () => {
        await vault.atomic("Home.md", "# Nuevo\n", hash("# Inicial\n"));
        await vault.atomic("00-Inbox/Nueva.md", "# Nueva\n", null);
      }),
    ),
  );
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await git("show", "HEAD:Home.md"), "# Nuevo");
  assert.equal(await git("show", "HEAD:00-Inbox/Nueva.md"), "# Nueva");
  assert.match(await git("log", "-1", "--format=%s"), /mcp/);
  assert.equal((await git("ls-files")).includes(".env"), false);
  await assert.rejects(
    vault.exclusive(() =>
      vault.transaction(async () => {
        await vault.atomic("Home.md", "incorrecto", hash("# Nuevo\n"));
        throw new Error("synthetic rollback");
      }),
    ),
    /synthetic rollback/,
  );
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await git("status", "--porcelain"), "");

  await writeFile(path.join(root, "Manual.md"), "unrelated staged content");
  await git("add", "Manual.md");
  await writeFile(path.join(root, "Home.md"), "# Externo\n");
  await assert.rejects(
    new GitHistory(root).record([{ relative: "Home.md" }], "mcp"),
    /preparados fuera/,
  );
  assert.equal(await git("rev-list", "--count", "HEAD"), "2");
});
