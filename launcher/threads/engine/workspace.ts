// Where a thread works: a Git worktree on a real branch (sb/<slug>) for repo
// threads, or a private folder for scratch threads.
import { access, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { GitRun } from "./checkpoints.ts";

export interface RepoWorkspaceInfo {
  path: string;
  baseBranch: string;
  branch: string;
  worktree: string;
  baseCommit: string;
}

export interface ThreadWorkspaces {
  /** Resolves a project name or a project's absolute path. */
  resolveProject(repo: string): string;
  prepareRepo(input: {
    threadId: string;
    title: string;
    repo: string;
    baseBranch?: string;
  }): Promise<RepoWorkspaceInfo>;
  prepareScratch(threadId: string): Promise<string>;
  /** Command that installs dependencies, or null when nothing to install. */
  setupCommand(cwd: string): Promise<string[] | null>;
  removeRepo(info: {
    path: string;
    worktree: string;
    branch: string;
    keepBranch: boolean;
  }): Promise<void>;
  removeScratch(dir: string): Promise<void>;
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** ASCII slug for a branch name; never empty. */
export function branchSlug(title: string, threadId: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = threadId.slice(-6).toLowerCase();
  return `sb/${slug || "thread"}-${suffix}`;
}

export function createThreadWorkspaces({
  git,
  projects,
  worktreesDir,
  scratchDir,
  npmCacheDir,
}: {
  git: GitRun;
  projects: Readonly<Record<string, string>>;
  worktreesDir: string;
  scratchDir: string;
  npmCacheDir: string;
}): ThreadWorkspaces {
  const projectDirs = new Set(Object.values(projects));

  return {
    resolveProject(repo) {
      const dir = projects[repo] ?? (projectDirs.has(repo) ? repo : undefined);
      if (!dir) throw new Error(`Proyecto desconocido: ${repo}`);
      return dir;
    },

    async prepareRepo({ threadId, title, repo, baseBranch }) {
      const repoPath = this.resolveProject(repo);
      const base =
        baseBranch ??
        (
          await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).stdout.trim();
      if (!base || base === "HEAD")
        throw new Error("El repositorio no tiene una rama base.");
      const baseCommit = (
        await git(repoPath, ["rev-parse", "--verify", `${base}^{commit}`])
      ).stdout.trim();
      const branch = branchSlug(title, threadId);
      await mkdir(worktreesDir, { recursive: true });
      const worktree = path.join(worktreesDir, threadId);
      await git(repoPath, ["worktree", "add", "-b", branch, worktree, base]);
      return {
        path: repoPath,
        baseBranch: base,
        branch,
        worktree: await realpath(worktree),
        baseCommit,
      };
    },

    async prepareScratch(threadId) {
      const dir = path.join(scratchDir, threadId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return realpath(dir);
    },

    async setupCommand(cwd) {
      if (!(await exists(path.join(cwd, "package-lock.json")))) return null;
      return [
        "npm",
        "ci",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--cache",
        npmCacheDir,
      ];
    },

    async removeRepo({ path: repoPath, worktree, branch, keepBranch }) {
      await git(repoPath, ["worktree", "remove", "--force", worktree]).catch(
        async () => {
          await rm(worktree, { recursive: true, force: true });
          await git(repoPath, ["worktree", "prune"]);
        },
      );
      if (!keepBranch)
        await git(repoPath, ["branch", "-D", branch]).catch(() => undefined);
    },

    async removeScratch(dir) {
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) !== path.resolve(scratchDir))
        throw new Error("Carpeta de trabajo fuera del área de threads.");
      await rm(resolved, { recursive: true, force: true });
    },
  };
}
