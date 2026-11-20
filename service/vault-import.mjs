import { Failure, stableId } from "./vault-identity.mjs";
import { validate, accountIndex } from "./vault-validation.mjs";
/** @this {import("./vault.mjs").Vault} */
export async function importItems(items) {
  return this.exclusive(async () => {
    try {
      return await this.transaction(async () => {
        if (!Array.isArray(items) || items.length > 20000)
          throw new Failure("Lote inválido.");
        const current = await this.snapshot();
        this.batchSnapshot = current;
        this.pendingPaths = new Set();
        this.indexBatch = [];
        const seen = new Set(current.items.map((x) => x.id));
        const external = new Set(
          current.items.map((x) => x.externalId).filter(Boolean),
        );
        const incoming = items.filter(
          (x) =>
            x.kind !== "notification" &&
            !seen.has(x.id) &&
            !(x.externalId && external.has(x.externalId)),
        );
        const accounts = accountIndex([...current.items, ...incoming]);
        for (const item of incoming) {
          const errors = validate(item, accounts);
          if (errors.length) throw new Failure(errors.join(" "));
        }
        let count = 0;
        for (const item of incoming.sort(
          (a, b) =>
            (a.kind === "account" ? 0 : a.kind === "project" ? 1 : 2) -
            (b.kind === "account" ? 0 : b.kind === "project" ? 1 : 2),
        )) {
          await this.apply({
            mutationId: stableId("import:" + item.id),
            baseVersion: 0,
            entity: item,
          });
          count++;
          if (count % 50 === 0)
            await new Promise((resolve) => setImmediate(resolve));
        }
        const indexIds = this.indexBatch;
        this.indexBatch = null;
        await this.index(indexIds);
        return { imported: count };
      });
    } finally {
      this.batchSnapshot = null;
      this.pendingPaths = null;
      this.indexBatch = null;
    }
  });
}
