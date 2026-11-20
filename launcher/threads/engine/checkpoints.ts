// Working-tree snapshots for threads: a tree object built in a throwaway
// index, so the thread's branch, index and HEAD are never touched. A turn
// records the tree before and after; diffs compare trees.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileDiff } from "../../../contracts/src/index.ts";

export type GitRun = (
  cwd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; max?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Tree id of the working directory, honouring .gitignore. */
export async function snapshotTree(git: GitRun, cwd: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-thread-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    if (head) await git(cwd, ["read-tree", head], { env });
    await git(cwd, ["add", "-A", "--", "."], { env });
    return (await git(cwd, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const statsOf = (patch: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
};

/** Splits `git diff` output into one FileDiff per file. */
export function parseGitDiff(output: string): FileDiff[] {
  const chunks = output.split(/^(?=diff --git )/m).filter((c) => c.trim());
  return chunks.map((patch) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(patch);
    const renameFrom = /^rename from (.+)$/m.exec(patch)?.[1];
    const renameTo = /^rename to (.+)$/m.exec(patch)?.[1];
    const isNew = /^new file mode/m.test(patch);
    const isDeleted = /^deleted file mode/m.test(patch);
    const body = patch.replace(/\n$/, "");
    return {
      path: renameTo ?? header?.[2] ?? "",
      ...(renameFrom ? { oldPath: renameFrom } : {}),
      change: renameFrom
        ? "rename"
        : isNew
          ? "add"
          : isDeleted
            ? "delete"
            : "modify",
      patch: body,
      ...statsOf(body),
    } satisfies FileDiff;
  });
}

const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "-M", "--binary"];

/** Diff between two trees or commits. */
export async function diffTrees(
  git: GitRun,
  cwd: string,
  from: string,
  to: string,
): Promise<FileDiff[]> {
  const { stdout } = await git(cwd, [...DIFF_ARGS, from, to, "--"], {
    max: 64 * 1024 * 1024,
  });
  return parseGitDiff(stdout);
}
