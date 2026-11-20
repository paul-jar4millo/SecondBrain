import { apply } from "./vault-mutations.mjs";
import { index, repeat } from "./vault-tasks.mjs";
import { importItems } from "./vault-import.mjs";
import { ledger } from "./vault-ledger.mjs";
import {
  readFile,
  readdir,
  mkdir,
  realpath,
  rename,
  stat,
  unlink,
  open,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  kinds,
  excludedRoots,
  aliases,
  fields,
  uuid,
  split,
  plain,
  displayText,
  dateString,
  cleanTitle,
} from "./vault-format.mjs";
import { validate, accountIndex } from "./vault-validation.mjs";
export { kinds } from "./vault-format.mjs";
export { validate } from "./vault-validation.mjs";
import { Journal } from "./journal.mjs";

export { hash, actorContext, stableId, Failure } from "./vault-identity.mjs";
import { hash, actorContext, stableId, Failure } from "./vault-identity.mjs";

/** @import { JournalEntry, VaultIssue, VaultItem, VaultMetadata, VaultMutation, VaultRecord, VaultSnapshot } from "./vault-types.d.ts" */

/** @param {string} start */
export async function discoverVault(start) {
  let current = path.resolve(start);
  while (true) {
    try {
      if (
        (await stat(path.join(current, "Home.md"))).isFile() &&
        (await stat(path.join(current, "00-Inbox"))).isDirectory()
      )
        return realpath(current);
    } catch {}
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error(
        "No se encontró el vault: configura VAULT_ROOT con la carpeta que contiene Home.md y 00-Inbox.",
      );
    current = parent;
  }
}
export class Vault {
  /**
   * @param {string} root
   * @param {string} [journalDirectory]
   * @param {{ history?: import("./history.mjs").History | null, versioning?: import("./vault-git.mjs").GitHistory | null }} [options]
   */
  constructor(
    root,
    journalDirectory = path.join(root, ".second-brain-runtime"),
    { history = null, versioning = null } = {},
  ) {
    this.root = path.resolve(root);
    this.history = history;
    this.versioning = versioning;
    this.queue = Promise.resolve();
    this.last = null;
    /** @type {Map<string, { signature: string, text: string, parts: ReturnType<typeof split> }>} */
    this.fileCache = new Map();
    this.metrics = { fileReads: 0, cacheHits: 0 };
    this.journalDirectory = journalDirectory;
    this.journal = null;
    /** @type {VaultIssue[]} */
    this.recoveryWarnings = [];
    // Set only while importItems() runs a batch (see vault-import.mjs).
    /** @type {VaultSnapshot | null} */
    this.batchSnapshot = null;
    /** @type {Set<string> | null} */
    this.pendingPaths = null;
    /** @type {string[] | null} */
    this.indexBatch = null;
  }
  async recover() {
    this.recoveryWarnings = await Journal.recover(this, this.journalDirectory);
  }
  async read() {
    await this.queue;
    return this.snapshot();
  }
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
  async transaction(fn) {
    const journal = new Journal(this, this.journalDirectory);
    this.journal = journal;
    try {
      const result = await fn();
      await journal.commit();
      await this.remember(journal.entries);
      return result;
    } catch (error) {
      this.recoveryWarnings.push(...(await journal.rollback()));
      throw error;
    } finally {
      this.journal = null;
    }
  }
  /** @param {JournalEntry[]} entries */
  async remember(entries) {
    if (!entries.length) return;
    // The write is already committed: a history failure is reported, never undone.
    try {
      await this.history?.record(entries, actorContext.getStore());
    } catch (error) {
      console.error("No se pudo guardar el historial de versiones:", error);
    }
    try {
      await this.versioning?.record(entries, actorContext.getStore());
    } catch (error) {
      console.error(
        "La nota está guardada, pero su commit Git está pendiente:",
        error.message,
      );
    }
  }
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
  async exclusive(fn) {
    const previous = this.queue;
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    this.queue = new Promise((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async files() {
    const out = [];
    /** @param {string} relative */
    const walk = async (relative) => {
      let entries;
      try {
        entries = await readdir(path.join(this.root, relative), {
          withFileTypes: true,
        });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const rel = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
      }
    };
    for (const entry of await readdir(this.root, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !excludedRoots.has(entry.name)
      )
        await walk(entry.name);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(entry.name);
    }
    return out.sort();
  }
  /** @param {unknown} relative */
  async safe(relative, allowMissing = false) {
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((p) => p === ".." || p.startsWith("."))
    )
      throw new Failure("Ruta del vault inválida.", 403);
    if (relative.includes("/") && excludedRoots.has(relative.split("/")[0]))
      throw new Failure("La ruta está fuera de las carpetas del vault.", 403);
    const full = path.join(this.root, relative);
    let check = full;
    while (true) {
      try {
        const resolved = await realpath(check);
        if (
          resolved !== this.root &&
          !resolved.startsWith(this.root + path.sep)
        )
          throw new Failure("No se permiten enlaces fuera del vault.", 403);
        break;
      } catch (e) {
        if (e.code !== "ENOENT" || !allowMissing) throw e;
        const parent = path.dirname(check);
        if (parent === check) throw e;
        check = parent;
      }
    }
    return full;
  }
  /**
   * @param {string[]} [filePaths]
   * @returns {Promise<VaultSnapshot>}
   */
  async snapshot(filePaths) {
    if (this.batchSnapshot && !filePaths) {
      if (this.pendingPaths.size) {
        const touched = [...this.pendingPaths];
        this.pendingPaths.clear();
        const changed = await this.snapshot(touched);
        const batch = this.batchSnapshot;
        for (const [id, record] of batch.records)
          if (touched.includes(record.relative)) batch.records.delete(id);
        for (const [id, record] of changed.records)
          batch.records.set(id, record);
        for (const [key, record] of changed.byPath)
          batch.byPath.set(key, record);
        batch.items = [...batch.records.values()].map((r) => r.item);
      }
      return this.batchSnapshot;
    }
    /** @type {Map<string, VaultRecord>} */
    const records = new Map();
    /** @type {Map<string, VaultRecord>} */
    const byPath = new Map();
    const issues = [...this.recoveryWarnings];
    const paths = filePaths || (await this.files());
    const livePaths = new Set(paths);
    for (const key of this.fileCache.keys())
      if (!filePaths && !livePaths.has(key)) this.fileCache.delete(key);
    for (const relative of paths) {
      let full, text, info;
      try {
        full = await this.safe(relative);
        info = await stat(full);
        if (info.size > 2 * 1024 * 1024) {
          issues.push({
            path: relative,
            message: "Nota de más de 2 MB: no se ha cargado.",
          });
          continue;
        }
        const signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        const cached = this.fileCache.get(relative);
        if (cached?.signature === signature) {
          text = cached.text;
          this.metrics.cacheHits++;
        } else {
          text = await readFile(full, "utf8");
          this.metrics.fileReads++;
          this.fileCache.set(relative, { signature, text, parts: split(text) });
        }
      } catch (e) {
        if (e.code === "ENOENT") continue;
        issues.push({
          path: relative,
          message: "No se pudo leer la nota de forma segura.",
        });
        continue;
      }
      const cachedParts = this.fileCache.get(relative).parts;
      const parts = { ...cachedParts, doc: cachedParts.doc.clone() };
      const metadata = plain(parts.doc);
      const sb =
        metadata.second_brain && typeof metadata.second_brain === "object"
          ? /** @type {VaultMetadata} */ (metadata.second_brain)
          : {};
      const rawId = sb.id || metadata.id;
      const id =
        typeof rawId === "string" && uuid.test(rawId)
          ? rawId
          : stableId(relative);
      const kind = relative.startsWith("99-Meta/Templates/")
        ? "note"
        : kinds.has(/** @type {string} */ (sb.kind))
          ? sb.kind
          : kinds.has(/** @type {string} */ (metadata.type))
            ? metadata.type
            : typeof metadata.type === "string" &&
                Object.hasOwn(aliases, metadata.type)
              ? aliases[metadata.type]
              : "note";
      const heading = parts.body.match(/^#\s+(.+)$/m)?.[1];
      const top = Object.fromEntries(
        fields
          .filter((key) => metadata[key] !== undefined)
          .map((key) => [key, metadata[key]]),
      );
      const item = /** @type {VaultItem} */ ({
        ...sb,
        ...top,
        id,
        kind,
        title: displayText(
          metadata.title || heading || path.basename(relative, ".md"),
        ),
        body: parts.body,
        version: hash(text),
        createdAt: dateString(sb.createdAt) || info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        vaultPath: relative,
        sourceKind: "document",
        status:
          metadata.status === undefined && sb.status === undefined
            ? undefined
            : displayText(metadata.status ?? sb.status),
        tags: Array.isArray(metadata.tags)
          ? metadata.tags.map(displayText)
          : [],
        area:
          metadata.area ||
          sb.area ||
          (relative.startsWith("02-Areas/")
            ? relative.split("/")[1]
            : undefined),
        verifiedAt: dateString(metadata.verified),
        expiresAt: dateString(metadata.expires),
        deleted: sb.deleted === true,
        validationErrors: undefined,
      });
      const invalid = [];
      if (item.area !== undefined) item.area = displayText(item.area);
      for (const key of [
        "date",
        "endDate",
        "time",
        "endTime",
        "timezone",
        "projectId",
        "plannedDate",
        "recurrence",
        "accountType",
        "currency",
        "accountId",
        "otherAccountId",
        "transactionType",
        "category",
        "dueDate",
        "source",
        "sourceHash",
        "externalId",
      ])
        if (item[key] !== undefined && typeof item[key] !== "string") {
          invalid.push("Tipo de propiedad inválido: " + key);
          item[key] = displayText(item[key]);
        }
      if (item.checked !== undefined && !Array.isArray(item.checked)) {
        invalid.push("checked debe ser una lista.");
        item.checked = [];
      }
      if (item.priority !== undefined && typeof item.priority !== "boolean") {
        invalid.push("priority debe ser booleano.");
        item.priority = false;
      }
      if (invalid.length) {
        item.validationErrors = invalid;
        issues.push({ path: relative, message: invalid.join(" ") });
      }
      delete item.lastMutation;
      const record = {
        item,
        relative,
        text,
        parts,
        metadata,
        sb,
        fileHash: hash(text),
      };
      if (parts.doc.errors.length) {
        item.validationErrors = [
          "Frontmatter YAML inválido: corrígelo en Obsidian antes de guardar.",
        ];
        issues.push({ path: relative, message: item.validationErrors[0] });
      }
      if (records.has(id)) {
        item.validationErrors = ["Identificador duplicado en el vault."];
        issues.push({ path: relative, message: item.validationErrors[0] });
        item.id = stableId("duplicate:" + relative);
      }
      records.set(item.id, record);
      byPath.set(relative, record);
      const lines = parts.body.split(/\r?\n/);
      let fence = false;
      const seen = new Map();
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (/^\s*(```|~~~)/.test(line)) {
          fence = !fence;
          continue;
        }
        if (fence) continue;
        const match = line.match(
          /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX/-])\]\s+(.*)$/,
        );
        if (!match) continue;
        /** @type {VaultMetadata} */
        let extra = {};
        try {
          const raw = match[3].match(/<!--\s*sb-task:(.*?)-->/)?.[1];
          if (raw) extra = JSON.parse(raw);
        } catch {
          issues.push({
            path: relative,
            message: "Metadatos de tarea inválidos en línea " + (index + 1),
          });
        }
        const anchor = match[3].match(/\s+\^sb-([0-9a-f-]{36})\s*$/)?.[1];
        const title = cleanTitle(match[3]);
        const occurrence = seen.get(title) || 0;
        seen.set(title, occurrence + 1);
        const taskId =
          anchor && uuid.test(anchor)
            ? anchor
            : stableId(relative + ":task:" + title + ":" + occurrence);
        const sourceLine =
          text.slice(0, text.length - parts.body.length).split("\n").length +
          index;
        const task = /** @type {VaultItem} */ ({
          ...extra,
          id: taskId,
          kind: "task",
          title,
          status: /[xX]/.test(match[2])
            ? "done"
            : match[2] === "-"
              ? "cancelled"
              : match[2] === "/"
                ? "doing"
                : "pending",
          date: match[3].match(/📅\s*(\d{4}-\d{2}-\d{2})/u)?.[1] || extra.date,
          plannedDate:
            match[3].match(/⏳\s*(\d{4}-\d{2}-\d{2})/u)?.[1] ||
            extra.plannedDate,
          projectId: extra.projectId || (kind === "project" ? id : undefined),
          version: hash(line),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          vaultPath: relative,
          sourceLine,
          sourceKind: "inline-task",
          area: item.area,
        });
        delete task.lastMutation;
        if (records.has(taskId)) {
          const message = "Identificador duplicado en el vault.";
          records.get(taskId).item.validationErrors = [message];
          task.validationErrors = [message];
          task.id = stableId("duplicate-task:" + relative + ":" + index);
          issues.push({ path: relative, message });
        }
        records.set(task.id, {
          ...record,
          item: task,
          sb: extra,
          lineIndex: index,
          line,
          marker: match[1],
        });
      }
    }
    const items = [...records.values()].map((r) => r.item);
    const accounts = accountIndex(items);
    for (const item of items)
      if (
        ["transaction", "account", "event", "statement"].includes(item.kind)
      ) {
        const errors = validate(item, accounts);
        if (errors.length) {
          item.validationErrors = [...(item.validationErrors || []), ...errors];
          issues.push({ path: item.vaultPath, message: errors.join(" ") });
        }
      }
    this.last = { records, byPath, items, issues };
    return this.last;
  }
  /**
   * @param {string} relative
   * @param {string} text
   * @param {string | null} expected
   */
  async atomic(relative, text, expected) {
    const full = await this.safe(relative, true);
    await mkdir(path.dirname(full), { recursive: true });
    await this.safe(relative, true);
    const temp = path.join(path.dirname(full), ".sb-" + randomUUID() + ".tmp");
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      let existing;
      try {
        existing = await readFile(full, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (
        (expected === null && existing !== undefined) ||
        (expected !== null && hash(existing ?? "") !== expected)
      )
        throw new Failure(
          "El archivo cambió en Obsidian durante el guardado. Revisa las dos versiones.",
          409,
        );
      if (this.journal)
        await this.journal.record(relative, existing ?? null, text);
      const latest = await readFile(full, "utf8").catch(
        /** @returns {null} */ (e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        },
      );
      if (
        (expected === null && latest !== null) ||
        (expected !== null && hash(latest ?? "") !== expected)
      )
        throw new Failure(
          "El archivo cambió durante la preparación del guardado.",
          409,
        );
      if (expected === null) {
        const { link } = await import("node:fs/promises");
        try {
          await link(temp, full);
        } catch (e) {
          if (e.code === "EEXIST") throw new Failure("La nota ya existe.", 409);
          throw e;
        }
        await unlink(temp);
      } else await rename(temp, full);
      this.fileCache.delete(relative);
      this.pendingPaths?.add(relative);
    } finally {
      if (handle) await handle.close();
      await unlink(temp).catch(() => {});
    }
  }
  /** @param {VaultMutation} mutation */
  async mutate(mutation) {
    return this.exclusive(() => this.transaction(() => this.apply(mutation)));
  }
  // Operations implemented in sibling modules, run with this vault as `this`.
  /** @param {Parameters<typeof apply>[0]} mutation */
  apply(mutation) {
    return apply.call(this, mutation);
  }
  /** @param {Parameters<typeof index>[0]} id */
  index(id) {
    return index.call(this, id);
  }
  /** @param {Parameters<typeof repeat>[0]} item */
  repeat(item) {
    return repeat.call(this, item);
  }
  /** @param {Parameters<typeof importItems>[0]} items */
  import(items) {
    return importItems.call(this, items);
  }
  ledger() {
    return ledger.call(this);
  }
}
