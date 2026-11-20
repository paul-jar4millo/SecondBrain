// Version history of vault writes: the previous content of every committed change and who
// made it. Operational recovery data, like the journal, not a second copy of the vault.
// It lives on the vault's disk, so it does not replace an off-host backup.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const pack = promisify(gzip);
const unpack = promisify(gunzip);
const DAY = 86_400_000;

export class History {
  constructor(
    directory,
    { days = Number(process.env.HISTORY_DAYS) || 90 } = {},
  ) {
    this.directory = directory;
    this.blobs = path.join(directory, "blobs");
    this.audit = path.join(directory, "audit.ndjson");
    this.days = days;
  }
  /** Journal entries of one committed transaction: { relative, before, afterHash }. */
  async record(entries, actor = "desconocido", at = Date.now()) {
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    let lines = "";
    for (const { relative, before, afterHash } of entries) {
      const previous = before === null ? null : hash(before);
      if (previous) await this.store(previous, before);
      lines +=
        JSON.stringify({
          at: new Date(at).toISOString(),
          actor,
          path: relative,
          before: previous,
          after: afterHash,
        }) + "\n";
    }
    await appendFile(this.audit, lines, { mode: 0o600 });
  }
  async store(id, text) {
    let handle;
    try {
      handle = await open(path.join(this.blobs, id + ".gz"), "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST") return;
      throw e;
    }
    try {
      await handle.writeFile(await pack(text));
    } finally {
      await handle.close();
    }
  }
  async entries() {
    let text;
    try {
      text = await readFile(this.audit, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    // A crash can leave a torn last line; every complete line is still valid.
    return text.split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  }
  /** Newest first. */
  async versions(relative) {
    return (await this.entries()).filter((e) => e.path === relative).reverse();
  }
  async read(id) {
    if (!/^[a-f0-9]{64}$/.test(id || "")) return null;
    try {
      return (
        await unpack(await readFile(path.join(this.blobs, id + ".gz")))
      ).toString("utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async prune(now = Date.now()) {
    const cutoff = now - this.days * DAY;
    const all = await this.entries();
    const kept = all.filter((e) => Date.parse(e.at) >= cutoff);
    if (kept.length !== all.length) {
      const temp = this.audit + ".tmp";
      await writeFile(
        temp,
        kept.map((e) => JSON.stringify(e) + "\n").join(""),
        {
          mode: 0o600,
        },
      );
      await rename(temp, this.audit);
    }
    const used = new Set(kept.map((e) => e.before).filter(Boolean));
    let files;
    try {
      files = await readdir(this.blobs);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const file of files)
      if (!used.has(file.replace(/\.gz$/, "")))
        await unlink(path.join(this.blobs, file));
  }
}

// Operator use on the server: node service/history.mjs list <path> | show <hash>
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const [command, value] = process.argv.slice(2);
  const history = new History(
    path.join(process.env.DATA_DIR || "/var/lib/secondbrain", "history"),
  );
  if (command === "list" && value)
    for (const e of await history.versions(value))
      console.log(
        `${e.at}  ${e.actor.padEnd(14)}  antes ${e.before ?? "(nueva)"}`,
      );
  else if (command === "show" && value) {
    const text = await history.read(value);
    if (text === null) {
      console.error("No existe esa versión.");
      process.exitCode = 1;
    } else process.stdout.write(text);
  } else {
    console.error("Uso: node service/history.mjs list <ruta.md> | show <hash>");
    process.exitCode = 2;
  }
}
