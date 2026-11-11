import type { Item } from "./model";
/** One index avoids scanning the full vault for each reminder. */
export function visibleReminders(items: Item[]): Item[] {
  const sources = new Map(items.map((item) => [item.id, item]));
  return items
    .filter((n) => {
      if (n.kind !== "notification" || n.deleted) return false;
      const source = n.source ? sources.get(n.source) : undefined;
      return !source || (!source.deleted && source.kind !== "note");
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
