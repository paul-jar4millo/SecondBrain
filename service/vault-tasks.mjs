import { Temporal } from "@js-temporal/polyfill";
import { stableId } from "./vault-identity.mjs";
/** @this {import("./vault.mjs").Vault} */
export async function index(id) {
  const ids = Array.isArray(id) ? id : [id];
  if (this.indexBatch) {
    this.indexBatch.push(...ids);
    return;
  }
  const relative = "00-Inbox/_App.md";
  const snapshot = await this.snapshot();
  const record = snapshot.byPath.get(relative);
  let text =
    record?.text ||
    "---\ntype: moc\nstatus: active\ntags: [moc, app]\n---\n\n# Contenido creado desde la app\n\n";
  const before = text;
  for (const key of ids) {
    const created = snapshot.records.get(key);
    if (!created) continue;
    const target =
      created.relative.replace(/\.md$/, "") +
      (created.item.sourceKind === "inline-task" ? "#^sb-" + key : "");
    if (text.includes(target)) continue;
    const link =
      "[[" + target + "|" + created.item.title.replace(/[[\]|\n]/g, " ") + "]]";
    text = text.replace(/\s*$/, "\n") + "- " + link + "\n";
  }
  if (text !== before)
    await this.atomic(relative, text, record?.fileHash ?? null);
}
/** @this {import("./vault.mjs").Vault} */
export async function repeat(item) {
  const snapshot = await this.snapshot();
  const id = stableId(item.id + ":next");
  if (snapshot.records.has(id)) return;
  const raw = item.date || item.plannedDate;
  const date = Temporal.PlainDate.from(raw);
  const anchor = item.recurrenceDay || date.day;
  let next =
    item.recurrence === "daily"
      ? date.add({ days: 1 })
      : item.recurrence === "weekly"
        ? date.add({ days: 7 })
        : date.with({ day: 1 }).add({ months: 1 });
  if (item.recurrence === "monthly")
    next = next.with({ day: Math.min(anchor, next.daysInMonth) });
  await this.apply({
    mutationId: stableId("repeat:" + item.id),
    baseVersion: 0,
    entity: {
      ...item,
      id,
      title: item.title,
      version: 0,
      status: "pending",
      priority: false,
      date: next.toString(),
      plannedDate: next.toString(),
      recurrenceDay: anchor,
      vaultPath: undefined,
      sourceLine: undefined,
      sourceKind: undefined,
    },
  });
}
