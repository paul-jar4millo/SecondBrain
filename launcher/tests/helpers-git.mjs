import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A synthetic repository with one commit, a .gitignore and two tracked files. */
export async function repoSintetico(t, { commit = true } = {}) {
  const raiz = await mkdtemp(path.join(tmpdir(), "sb-cp-"));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  const cwd = await realpath(raiz);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.test");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "core.autocrlf", "false");
  await writeFile(
    path.join(cwd, ".gitignore"),
    "ignorado.log\nnode_modules/\n",
  );
  await writeFile(path.join(cwd, "a.txt"), "uno\n");
  await writeFile(path.join(cwd, "b.txt"), "dos\n");
  if (commit) {
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "chore: inicio");
  }
  return cwd;
}
