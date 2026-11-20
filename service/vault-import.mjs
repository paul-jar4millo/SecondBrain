import { Failure, stableId } from "./vault-identity.mjs";
import { validate, accountIndex } from "./vault-validation.mjs";
/**
 * @this {import("./vault.mjs").Vault}
 * @param {(import("./vault-types.d.ts").VaultItem | { id: string, kind: "notification", externalId?: string })[]} items
 * @returns {Promise<{ imported: number }>}
 */
export async function importItems(items) {
  // A named alias: assigning this.x would make TypeScript read a constructor.
  const vault = this;
  return vault.exclusive(async () => {
    try {
      return await vault.transaction(async () => {
        if (!Array.isArray(items) || items.length > 20000)
          throw new Failure("Lote inválido.");
        const current = await vault.snapshot();
        vault.batchSnapshot = current;
        vault.pendingPaths = new Set();
        vault.indexBatch = [];
        const seen = new Set(current.items.map((x) => x.id));
        const external = new Set(
          current.items.map((x) => x.externalId).filter(Boolean),
        );
        const incoming = items.filter(
          /** @returns {x is import("./vault-types.d.ts").VaultItem} */
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
          await vault.apply({
            mutationId: stableId("import:" + item.id),
            baseVersion: 0,
            entity: item,
          });
          count++;
          if (count % 50 === 0)
            await new Promise((resolve) => setImmediate(resolve));
        }
        const indexIds = vault.indexBatch;
        vault.indexBatch = null;
        await vault.index(indexIds);
        return { imported: count };
      });
    } finally {
      vault.batchSnapshot = null;
      vault.pendingPaths = null;
      vault.indexBatch = null;
    }
  });
}
