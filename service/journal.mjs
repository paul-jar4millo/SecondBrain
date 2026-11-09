// @ts-check
import {
  mkdir,
  open,
  rename,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const read = async (file) => {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
export class Journal {
  constructor(vault, directory, entries = [], file) {
    this.vault = vault;
    this.directory = directory;
    this.entries = entries;
    this.file = file || path.join(directory, randomUUID() + ".json");
  }
  async record(relative, before, after) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.entries.push({ relative, before, afterHash: hash(after) });
    const temp = this.file + ".tmp";
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ schemaVersion: 1, entries: this.entries }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.file);
  }
  async commit() {
    await unlink(this.file).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async rollback() {
    const warnings = [];
    for (const entry of [...this.entries].reverse()) {
      const full = await this.vault.safe(entry.relative, true);
      const current = await read(full);
      if (current === entry.before) continue;
      if (current === null || hash(current) !== entry.afterHash) {
        warnings.push({
          path: entry.relative,
          message:
            "La recuperación encontró una edición externa; la conserva. El journal contiene la versión anterior para revisión.",
        });
        continue;
      }
      if (entry.before === null) await unlink(full);
      else {
        const temp = path.join(
          path.dirname(full),
          ".sb-recover-" + randomUUID() + ".tmp",
        );
        await writeFile(temp, entry.before, { mode: 0o600 });
        if (hash((await read(full)) ?? "") === entry.afterHash)
          await rename(temp, full);
        else {
          await unlink(temp);
          warnings.push({
            path: entry.relative,
            message:
              "El archivo volvió a cambiar durante la recuperación y se conservó.",
          });
        }
      }
    }
    if (warnings.length)
      await rename(this.file, this.file + ".conflict").catch(() => {});
    else await this.commit();
    return warnings;
  }
  static async recover(vault, directory) {
    let files;
    try {
      files = await readdir(directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const warnings = [];
    for (const file of files) {
      if (file.endsWith(".conflict")) {
        warnings.push({
          path: file,
          message:
            "Hay una operación recuperada que conserva cambios externos; revisa el journal antes de descartarlo.",
        });
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const full = path.join(directory, file);
      const data = JSON.parse(await readFile(full, "utf8"));
      if (data.schemaVersion !== 1 || !Array.isArray(data.entries))
        throw new Error(
          "Journal de recuperación inválido. Conserva la carpeta y revisa la operación.",
        );
      warnings.push(
        ...(await new Journal(vault, directory, data.entries, full).rollback()),
      );
    }
    return warnings;
  }
}
