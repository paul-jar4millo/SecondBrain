// Finance module: one structured Markdown document is the source of truth.
// Everything shown in the UI (utilization, cash-flow margin, categories, alerts)
// is derived by overview() on every read; nothing computed is persisted.
import { readFile } from "node:fs/promises";
import { parseDocument, Document } from "yaml";
import { Failure, hash } from "./vault.mjs";
/** @import { Vault } from "./vault.mjs" */
/** @import { FinanceData, FinanceOperation } from "./finance-types.d.ts" */
/** @import { YAMLMap, YAMLSeq } from "yaml" */

/** @typedef {Record<string, { result: ReturnType<typeof applyOperation>["result"] }>} FinanceReceipts */
/**
 * @typedef {object} ExistingFinance
 * @property {true} exists
 * @property {string} source
 * @property {ReturnType<typeof parseDocument> | Document} doc
 * @property {FinanceData} data
 * @property {string} body
 * @property {string} newline
 * @property {string} fileHash
 * @property {FinanceReceipts} [receipts]
 */
/** @typedef {ExistingFinance | { exists: false, data?: undefined, receipts?: FinanceReceipts }} LoadedFinance */

/** @param {unknown} node @returns {FinanceReceipts | undefined} */
const toPlain = (node) =>
  /** @type {{ toJSON: () => FinanceReceipts } | undefined} */ (node)?.toJSON();

export const FINANCE_PATH = "02-Areas/Finanzas/Datos-financieros.md";
const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const DEFAULT_BODY =
  "\n# Datos financieros\n\nDocumento estructurado que mantienen la app y los agentes (`node dashboard/ops/sb.mjs finance ...`). Se muestra en la sección Finanzas; no hace falta editarlo a mano.\n";

export * from "./finance-domain.mjs";
import {
  emptyFinance,
  normalize,
  overview,
  applyOperation,
  addDays,
  mexicoDay,
} from "./finance-domain.mjs";
/* ---------- persistence ---------- */
export class Finance {
  /** @param {Vault} vault */
  constructor(vault) {
    this.vault = vault;
  }
  /** @returns {Promise<LoadedFinance>} */
  async load() {
    let source;
    try {
      source = await readFile(
        await this.vault.safe(FINANCE_PATH, true),
        "utf8",
      );
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw error;
    }
    const match = source.match(FRONTMATTER);
    const doc = match
      ? parseDocument(match[1], { uniqueKeys: true })
      : new Document({});
    if (doc.errors.length)
      throw new Failure(
        "Datos financieros con YAML inválido: repara el archivo antes de editarlo.",
        409,
      );
    const raw = /** @type {{ toJSON?: () => unknown }} */ (doc.get("finance"));
    const data = normalize(
      raw && typeof raw.toJSON === "function" ? raw.toJSON() : raw,
    );
    return {
      exists: true,
      source,
      doc,
      data,
      body: match ? source.slice(match[0].length) : source,
      newline: source.includes("\r\n") ? "\r\n" : "\n",
      fileHash: hash(source),
    };
  }
  /** @param {string} today */
  async overview(today) {
    await this.vault.queue;
    const loaded = await this.load();
    if (!loaded.exists) return { configured: false };
    return overview(loaded.data, today);
  }
  /** @param {FinanceOperation} op */
  async previous(op) {
    if (!op?.requestId) return undefined;
    await this.vault.queue;
    const loaded = await this.load();
    const receipts = loaded.exists
      ? (toPlain(loaded.doc.get("financeReceipts")) ?? {})
      : {};
    return Object.hasOwn(receipts, op.requestId)
      ? {
          result: receipts[op.requestId].result,
          overview: overview(loaded.data, mexicoDay()),
        }
      : undefined;
  }
  /** @param {FinanceOperation} op @param {string} today */
  async validate(op, today) {
    await this.vault.queue;
    const loaded = await this.load();
    if (!loaded.exists && op?.op !== "init")
      throw new Failure("Aún no hay datos financieros.", 404);
    return applyOperation(
      loaded.exists ? loaded.data : emptyFinance(today),
      op,
      today,
    );
  }
  /**
   * Compact receipts and balances share the vault's atomic journal transaction.
   * A retry returns the original operation result and the current financial overview.
   * @param {FinanceOperation} op
   * @param {string} today
   */
  async run(op, today) {
    const requestId = typeof op?.requestId === "string" ? op.requestId : null;
    if (requestId && requestId.length > 100)
      throw new Failure("requestId admite hasta 100 caracteres.");
    if (requestId) {
      const { requestId: _, ...rest } = op;
      op = rest;
    }
    return this.vault.exclusive(() => {
      return this.vault.transaction(async () => {
        const loaded = await this.load();
        if (!loaded.exists && op?.op !== "init")
          throw new Failure(
            "Aún no hay datos financieros. Crea el archivo con la operación init.",
            404,
          );
        const receipts = loaded.exists
          ? (toPlain(loaded.doc.get("financeReceipts")) ?? {})
          : {};
        if (requestId && Object.hasOwn(receipts, requestId))
          return {
            result: structuredClone(receipts[requestId].result),
            overview: overview(loaded.data, today),
          };
        const base = loaded.exists ? loaded.data : emptyFinance(today);
        const { data, result } = applyOperation(base, op, today);
        if (!loaded.exists && op.initial)
          Object.assign(data, normalize(op.initial));
        const reply = { result, overview: overview(data, today) };
        if (requestId) {
          Object.defineProperty(receipts, requestId, {
            value: { result },
            enumerable: true,
            configurable: true,
          });
          loaded.receipts = Object.fromEntries(
            Object.entries(receipts).slice(-200),
          );
        }
        await this.write(loaded, data, today);
        return reply;
      });
    });
  }
  /**
   * Writes the whole structure (used by init/import and by run).
   * @param {LoadedFinance} loaded
   * @param {FinanceData} data
   * @param {string} today
   */
  async write(loaded, data, today) {
    const doc = loaded.exists
      ? loaded.doc
      : new Document({
          type: "finanzas",
          status: "active",
          tags: ["area/finanzas", "datos"],
        });
    if (loaded.receipts) doc.set("financeReceipts", loaded.receipts);
    doc.set("updated", today);
    doc.set("verified", data.reconciledAt);
    // validate() requires reconciledAt before a snapshot is written.
    doc.set(
      "expires",
      addDays(/** @type {string} */ (data.reconciledAt), data.validityDays),
    );
    const node = doc.createNode(data);
    for (const key of [
      "installments",
      "commitments",
      "cash",
      "transactions",
      "questions",
    ]) {
      // These keys contain sequences of mappings in the node we just created.
      const seq = /** @type {YAMLSeq<YAMLMap> | undefined} */ (
        /** @type {unknown} */ (node.get(key, true))
      );
      if (seq?.items) for (const item of seq.items) item.flow = true;
    }
    doc.set("finance", node);
    const newline = loaded.exists ? loaded.newline : "\n";
    const output =
      "---" +
      newline +
      doc.toString({ lineWidth: 0 }).trimEnd().replace(/\n/g, newline) +
      newline +
      "---" +
      newline +
      (loaded.exists ? loaded.body : DEFAULT_BODY);
    await this.vault.atomic(
      FINANCE_PATH,
      output,
      loaded.exists ? loaded.fileHash : null,
    );
  }
  /**
   * Used by the one-time importer: creates the file from a complete structure.
   * @param {FinanceData} data
   * @param {string} today
   */
  async create(data, today) {
    return this.vault.exclusive(() =>
      this.vault.transaction(async () => {
        const loaded = await this.load();
        if (loaded.exists)
          throw new Failure(
            "Ya existen datos financieros; no se sobrescriben.",
            409,
          );
        await this.write(loaded, normalize(data), today);
        return overview(normalize(data), today);
      }),
    );
  }
}
