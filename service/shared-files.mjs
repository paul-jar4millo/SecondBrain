import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
/** @import { Readable } from "node:stream" */

/**
 * @typedef {object} SharedFileRecord
 * @property {string} id
 * @property {string} area
 * @property {string} name
 * @property {number} size
 * @property {string} sha256
 * @property {string} mime
 * @property {string} [actor]
 * @property {string} note
 * @property {boolean} pinned
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {string} [trashedAt]
 */
/**
 * @typedef {object} SharedUpload
 * @property {string | null} area
 * @property {unknown} name
 * @property {unknown} [note]
 * @property {string} [actor]
 */

/**
 * "Maletín": a folder shared between the owner (browser) and the agents (MCP/API).
 * Files live outside the vault under opaque ids; the index maps ids to names, so
 * no user-supplied name ever reaches the filesystem.
 */
export const AREAS = ["para-agentes", "de-agentes"];
export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
// Chunks travel as base64 inside the agent's context, which the CLIs keep in
// memory: an 80 MB file got Codex OOM-killed. Larger files go straight to disk.
export const MAX_INLINE = 8 * 1024 * 1024;
const RETENTION_DAYS = 30;
const TRASH_DAYS = 7;
/** @type {Record<string, string>} */
const TYPES = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Plain-text formats, so files_get can return them as text to the agents.
  ...Object.fromEntries(
    "log yaml yml xml tsv ini toml py js mjs cjs ts tsx jsx sh ps1 sql css"
      .split(" ")
      .map((extension) => [extension, "text/plain"]),
  ),
};
// Any type is accepted: files are stored under opaque ids and always downloaded
// as attachments (see downloadHeaders), so the type only guides how agents read.
const UNKNOWN_TYPE = "application/octet-stream";
const MAX_NAME = 120;
/** @param {unknown} value */
export function cleanName(value) {
  const base = String(value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "")
    .trim();
  if (/^\.*$/.test(base)) return "";
  // Long names keep their extension, which is what identifies the file.
  const extension = path.extname(base).slice(0, 20);
  return base.length > MAX_NAME
    ? base.slice(0, MAX_NAME - extension.length) + extension
    : base;
}
/**
 * @param {string} directory
 * @param {new (message: string, status?: number) => Error} Failure
 * @param {{ onChange?: () => void }} [options]
 */
export function createSharedFiles(directory, Failure, { onChange } = {}) {
  const root = path.resolve(directory);
  const indexFile = path.join(root, "index.json");
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  /** @returns {Promise<SharedFileRecord[]>} */
  async function load() {
    await mkdir(root, { recursive: true });
    try {
      return (
        /** @type {{ files?: SharedFileRecord[] }} */ (
          JSON.parse(await readFile(indexFile, "utf8"))
        ).files ?? []
      );
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw new Failure("El índice del Maletín no se pudo leer.", 500);
    }
  }
  /** @param {SharedFileRecord[]} files */
  async function save(files) {
    const temporary = indexFile + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify({ version: 1, files }, null, 1));
    await rename(temporary, indexFile);
  }
  /** @param {Pick<SharedFileRecord, "area" | "id">} entry */
  const location = (entry) => path.join(root, entry.area, entry.id);
  /** @param {SharedFileRecord[]} files */
  const live = (files) => files.filter((f) => !f.trashedAt);
  /** @param {SharedFileRecord} f */
  const publicEntry = (f) => ({
    id: f.id,
    area: f.area,
    name: f.name,
    size: f.size,
    sha256: f.sha256,
    mime: f.mime,
    actor: f.actor,
    note: f.note,
    pinned: f.pinned,
    createdAt: f.createdAt,
    expiresAt: f.pinned ? null : f.expiresAt,
    trashedAt: f.trashedAt ?? null,
  });
  /** @param {SharedFileRecord[]} files */
  async function prune(files) {
    const now = Date.now();
    const kept = [];
    let changed = false;
    for (const f of files) {
      if (!f.trashedAt && !f.pinned && Date.parse(f.expiresAt) < now) {
        f.trashedAt = new Date(now).toISOString();
        changed = true;
      }
      if (
        f.trashedAt &&
        Date.parse(f.trashedAt) + TRASH_DAYS * 86400000 < now
      ) {
        await rm(location(f), { force: true });
        changed = true;
        continue;
      }
      kept.push(f);
    }
    if (changed) await save(kept);
    return kept;
  }
  /** @param {unknown} name @param {string | null} area @param {number} size @param {number} total */
  function describe(name, area, size, total) {
    if (!AREAS.includes(area)) throw new Failure("Carpeta desconocida.");
    const clean = cleanName(name);
    const extension = path.extname(clean).slice(1).toLowerCase();
    if (!clean) throw new Failure("El nombre del archivo no es válido.");
    if (size > MAX_FILE) throw new Failure("El archivo supera 100 MB.", 413);
    if (total + size > MAX_TOTAL)
      throw new Failure("El Maletín alcanzó su límite de 2 GB.", 507);
    return {
      clean,
      mime: Object.hasOwn(TYPES, extension) ? TYPES[extension] : UNKNOWN_TYPE,
    };
  }
  /** @param {SharedUpload} upload @param {string} temporary @param {number} size @param {string} sha */
  async function register({ area, name, note, actor }, temporary, size, sha) {
    return exclusive(async () => {
      const files = await prune(await load());
      const total = live(files).reduce((sum, f) => sum + f.size, 0);
      let meta;
      try {
        meta = describe(name, area, size, total);
      } catch (e) {
        await rm(temporary, { force: true });
        throw e;
      }
      const id = randomUUID();
      const entry = {
        id,
        area,
        name: meta.clean,
        size,
        sha256: sha,
        mime: meta.mime,
        actor,
        note: String(note ?? "").slice(0, 300),
        pinned: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() + RETENTION_DAYS * 86400000,
        ).toISOString(),
      };
      await mkdir(path.join(root, area), { recursive: true });
      await rename(temporary, location(entry));
      files.push(entry);
      await save(files);
      onChange?.();
      return publicEntry(entry);
    });
  }
  async function temporaryFile() {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    return path.join(root, ".tmp", randomUUID());
  }
  return {
    /** @param {{ trashed?: boolean }} [options] */
    async list({ trashed = false } = {}) {
      return exclusive(async () => {
        const files = await prune(await load());
        return files
          .filter((f) => Boolean(f.trashedAt) === trashed)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(publicEntry);
      });
    },
    /**
     * Small uploads (MCP, JSON): content already in memory.
     * @param {SharedUpload & { buffer: Buffer }} upload
     */
    async put({ area, name, note, actor, buffer }) {
      if (buffer.length > MAX_FILE)
        throw new Failure("El archivo supera 100 MB.", 413);
      const temporary = await temporaryFile();
      await writeFile(temporary, buffer);
      return register(
        { area, name, note, actor },
        temporary,
        buffer.length,
        createHash("sha256").update(buffer).digest("hex"),
      );
    },
    /**
     * Browser uploads: stream the raw request body to disk with a hard cap.
     * @param {SharedUpload & { stream: Readable }} upload
     */
    async putStream({ area, name, note, actor, stream }) {
      const total = await exclusive(async () =>
        live(await prune(await load())).reduce((sum, f) => sum + f.size, 0),
      );
      describe(name, area, 0, total);
      const remaining = MAX_TOTAL - total;
      if (remaining <= 0)
        throw new Failure("El Maletín alcanzó su límite de 2 GB.", 507);
      const temporary = await temporaryFile();
      const hash = createHash("sha256");
      let size = 0;
      const out = createWriteStream(temporary);
      try {
        await new Promise((resolve, reject) => {
          out.on("error", reject);
          out.on("finish", () => resolve(undefined));
          stream.on("error", reject);
          stream.on("data", (/** @type {Buffer | string} */ chunk) => {
            size += chunk.length;
            if (size > MAX_FILE || size > remaining) {
              stream.destroy();
              out.destroy();
              reject(new Failure("El archivo supera 100 MB.", 413));
              return;
            }
            hash.update(chunk);
            if (!out.write(chunk)) {
              stream.pause();
              out.once("drain", () => stream.resume());
            }
          });
          stream.on("end", () => out.end());
        });
      } catch (e) {
        await rm(temporary, { force: true });
        throw e;
      }
      if (size === 0) {
        await rm(temporary, { force: true });
        throw new Failure("El archivo está vacío.");
      }
      return register(
        { area, name, note, actor },
        temporary,
        size,
        hash.digest("hex"),
      );
    },
    /** @param {string | null} id */
    async find(id) {
      const files = await exclusive(async () => prune(await load()));
      const entry = files.find((f) => f.id === id && !f.trashedAt);
      if (!entry) throw new Failure("Archivo no encontrado.", 404);
      return { entry: publicEntry(entry), file: location(entry) };
    },
    /** @param {string | null} id @param {number} offset @param {number} length */
    async chunk(id, offset, length) {
      const { entry, file } = await this.find(id);
      if (entry.size > MAX_INLINE)
        throw new Failure(
          `«${entry.name}» pesa ${Math.ceil(entry.size / 1048576)} MB y no cabe en el contexto. Guárdalo en disco con files_download; en el MCP remoto, tu usuario lo descarga desde el Maletín.`,
          413,
        );
      const { open } = await import("node:fs/promises");
      const handle = await open(file, "r");
      try {
        const size = Math.min(length, Math.max(0, entry.size - offset));
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, offset);
        return { entry, offset, bytes: size, buffer };
      } finally {
        await handle.close();
      }
    },
    /** @param {string} id @param {{ onlyArea?: string }} [options] */
    async trash(id, { onlyArea } = {}) {
      return exclusive(async () => {
        const files = await load();
        const entry = files.find((f) => f.id === id && !f.trashedAt);
        if (!entry) throw new Failure("Archivo no encontrado.", 404);
        if (onlyArea && entry.area !== onlyArea)
          throw new Failure(
            "Las agentes solo pueden quitar archivos de «" + onlyArea + "».",
            403,
          );
        entry.trashedAt = new Date().toISOString();
        await save(files);
        onChange?.();
        return publicEntry(entry);
      });
    },
    /** @param {string} id */
    async restore(id) {
      return exclusive(async () => {
        const files = await load();
        const entry = files.find((f) => f.id === id && f.trashedAt);
        if (!entry) throw new Failure("Archivo no encontrado.", 404);
        delete entry.trashedAt;
        entry.expiresAt = new Date(
          Date.now() + RETENTION_DAYS * 86400000,
        ).toISOString();
        await save(files);
        onChange?.();
        return publicEntry(entry);
      });
    },
    /** @param {string} id @param {unknown} pinned */
    async pin(id, pinned) {
      return exclusive(async () => {
        const files = await load();
        const entry = files.find((f) => f.id === id && !f.trashedAt);
        if (!entry) throw new Failure("Archivo no encontrado.", 404);
        entry.pinned = Boolean(pinned);
        await save(files);
        onChange?.();
        return publicEntry(entry);
      });
    },
    async exists() {
      return stat(root).then(
        () => true,
        () => false,
      );
    },
  };
}
/** @param {Pick<SharedFileRecord, "name" | "size">} entry */
export function downloadHeaders(entry) {
  const ascii = entry.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": entry.size,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
