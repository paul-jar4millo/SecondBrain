// @ts-check
import fs from "node:fs";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";

// Runs within the write queue without launching a CLI or contacting GitHub.
// A separate systemd job pushes committed versions, even if the UI is closed.
export class GitHistory {
  constructor(root) {
    this.root = path.resolve(root);
  }
  async check() {
    const root = await git.findRoot({ fs, filepath: this.root });
    if ((await realpath(root)) !== (await realpath(this.root)))
      throw new Error("El vault debe tener su propio repositorio Git.");
  }
  async record(entries, actor = "app") {
    if (!entries.length) return;
    await this.check();
    const files = [...new Set(entries.map((entry) => entry.relative))];
    const options = { fs, dir: this.root };
    const before = await git.statusMatrix(options);
    if (
      before.some(
        ([file, head, , stage]) => head !== stage && !files.includes(file),
      )
    )
      throw new Error(
        "Hay cambios preparados fuera de la transacción; revisar el índice Git.",
      );
    for (const filepath of files) {
      const exists = await lstat(path.join(this.root, filepath)).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        },
      );
      if (exists) await git.add({ ...options, filepath });
      else await git.remove({ ...options, filepath });
    }
    const staged = await git.statusMatrix({ ...options, filepaths: files });
    if (!staged.some(([, head, , stage]) => head !== stage)) return;
    const actorName = String(actor)
      .replace(/[\r\n]/g, " ")
      .slice(0, 100);
    await git.commit({
      ...options,
      message: `Vault: ${actorName} (${files.length} archivos)`,
      author: { name: "SecondBrain", email: "secondbrain@localhost" },
    });
  }
}
