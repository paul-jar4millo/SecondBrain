// Closing a thread: open a pull request, merge locally, or discard. A local
// merge is computed with `git merge-tree` first, so a conflict never leaves
// half-merged files in anybody's checkout.
import type { GitRun } from "./checkpoints.ts";

export class CloseError extends Error {
  readonly conflicts: string[];
  constructor(message: string, conflicts: string[] = []) {
    super(message);
    this.conflicts = conflicts;
  }
}

export interface RepoRef {
  path: string;
  worktree: string;
  branch: string;
  baseBranch: string;
}

const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S/;

/** A Conventional Commits title for the thread's work. */
export function commitTitle(title: string | undefined, fallback: string) {
  const text = (title ?? fallback).trim().replace(/\s+/g, " ").slice(0, 100);
  return CONVENTIONAL.test(text)
    ? text
    : `feat: ${text || "cambios del thread"}`;
}

const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: "SecondBrain",
  GIT_AUTHOR_EMAIL: "agente@secondbrain.invalid",
  GIT_COMMITTER_NAME: "SecondBrain",
  GIT_COMMITTER_EMAIL: "agente@secondbrain.invalid",
};

export function createClosing({ git, gh }: { git: GitRun; gh: GitRun }) {
  const identity = async (cwd: string) =>
    (
      await git(cwd, ["config", "user.email"]).catch(() => ({ stdout: "" }))
    ).stdout.trim()
      ? {}
      : FALLBACK_IDENTITY;

  /** Commits whatever the agent left uncommitted on the thread's branch. */
  async function commitPending(repo: RepoRef, title: string) {
    const cwd = repo.worktree;
    await git(cwd, ["add", "-A"]);
    const clean = await git(cwd, ["diff", "--cached", "--quiet"]).then(
      () => true,
      () => false,
    );
    if (clean) return false;
    try {
      await git(cwd, ["commit", "-m", title], {
        env: await identity(cwd),
        timeout: 120_000,
      });
    } catch {
      throw new CloseError(
        "No se pudo crear el commit; revisa los hooks del repositorio.",
      );
    }
    return true;
  }

  const ahead = async (repo: RepoRef) =>
    Number(
      (
        await git(repo.worktree, [
          "rev-list",
          "--count",
          `${repo.baseBranch}..${repo.branch}`,
        ])
      ).stdout.trim(),
    ) || 0;

  async function pullRequest(repo: RepoRef, title: string, body: string) {
    await commitPending(repo, title);
    if (!(await ahead(repo)))
      throw new CloseError("No hay cambios para enviar en un PR.");
    try {
      await git(repo.worktree, ["push", "-u", "origin", repo.branch], {
        timeout: 120_000,
      });
    } catch {
      throw new CloseError(
        "No se pudo enviar la rama al remoto. El commit quedó en local.",
      );
    }
    const open = await gh(repo.worktree, [
      "pr",
      "view",
      repo.branch,
      "--json",
      "url,state",
    ]).then(
      (r) => {
        const data = JSON.parse(r.stdout) as { url?: string; state?: string };
        return data.state === "OPEN" ? (data.url ?? null) : null;
      },
      () => null,
    );
    if (open) return open;
    let output: string;
    try {
      output = (
        await gh(
          repo.worktree,
          [
            "pr",
            "create",
            "--head",
            repo.branch,
            "--base",
            repo.baseBranch,
            "--title",
            title,
            "--body",
            body,
          ],
          { timeout: 120_000 },
        )
      ).stdout;
    } catch {
      throw new CloseError("La rama se envió, pero gh no pudo abrir el PR.");
    }
    const url = /https?:\/\/\S+/.exec(output)?.[0];
    if (!url) throw new CloseError("gh no devolvió la dirección del PR.");
    return url;
  }

  /** Worktree where `branch` is checked out, if any. */
  async function checkoutOf(repoPath: string, branch: string) {
    const { stdout } = await git(repoPath, ["worktree", "list", "--porcelain"]);
    let current: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      else if (line === `branch refs/heads/${branch}`) return current;
    }
    return null;
  }

  async function mergeLocal(repo: RepoRef, title: string) {
    await commitPending(repo, title);
    const base = (
      await git(repo.path, [
        "rev-parse",
        "--verify",
        `refs/heads/${repo.baseBranch}`,
      ])
    ).stdout.trim();
    const head = (
      await git(repo.path, [
        "rev-parse",
        "--verify",
        `refs/heads/${repo.branch}`,
      ])
    ).stdout.trim();
    if (!(await ahead(repo)))
      throw new CloseError("No hay cambios para integrar.");
    // Dry run: a conflict is reported without touching any working tree.
    const merged = await git(repo.path, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      base,
      head,
    ]).then(
      (r) => ({
        ok: true as const,
        tree: r.stdout.split("\n")[0]?.trim() ?? "",
      }),
      (error: { stdout?: string }) => ({
        ok: false as const,
        files: String(error.stdout ?? "")
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    );
    if (!merged.ok)
      throw new CloseError(
        "La rama tiene conflictos con la rama base; nada se modificó.",
        merged.files,
      );
    const commit = (
      await git(
        repo.path,
        [
          "commit-tree",
          merged.tree,
          "-p",
          base,
          "-p",
          head,
          "-m",
          `${title}\n\nMerge branch '${repo.branch}' into ${repo.baseBranch}`,
        ],
        { env: await identity(repo.path) },
      )
    ).stdout.trim();
    const checkout = await checkoutOf(repo.path, repo.baseBranch);
    if (checkout) {
      // The base branch is checked out: fast-forward it there, so its files
      // follow. This fails without changes if local edits are in the way.
      try {
        await git(checkout, ["merge", "--ff-only", commit]);
      } catch {
        throw new CloseError(
          `La copia de trabajo de ${repo.baseBranch} tiene cambios locales que lo impiden; nada se modificó.`,
        );
      }
    } else
      await git(repo.path, [
        "update-ref",
        `refs/heads/${repo.baseBranch}`,
        commit,
        base,
      ]);
    return commit;
  }

  return { commitPending, pullRequest, mergeLocal };
}

export type Closing = ReturnType<typeof createClosing>;
