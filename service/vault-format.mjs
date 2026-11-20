import { parseDocument, Document } from "yaml";
export const kinds = new Set([
  "note",
  "project",
  "task",
  "inbox",
  "event",
  "account",
  "transaction",
  "obligation",
  "review",
  "statement",
]);
export const excludedRoots = new Set([
  "apps",
  "skills",
  "tooling",
  "node_modules",
  "artifacts",
  "dist",
  "shared",
  "scratch",
  "library-files",
  "SecondBrain",
  "secrets",
]);
export const aliases = {
  nota: "note",
  recurso: "note",
  moc: "note",
  meta: "note",
  proyecto: "project",
  tarea: "task",
  evento: "event",
  cuenta: "account",
  movimiento: "transaction",
  compromiso: "obligation",
  revision: "review",
  corte: "statement",
  inbox: "inbox",
};
export const types = {
  note: "nota",
  project: "proyecto",
  task: "tarea",
  inbox: "inbox",
  event: "evento",
  account: "cuenta",
  transaction: "movimiento",
  obligation: "compromiso",
  review: "revision",
  statement: "corte",
};
export const folders = {
  note: "00-Inbox/App",
  inbox: "00-Inbox/App",
  task: "00-Inbox/Tareas",
  project: "01-Proyectos/App",
  event: "02-Areas/Agenda/App",
  account: "02-Areas/Finanzas/App",
  transaction: "02-Areas/Finanzas/App",
  obligation: "02-Areas/Finanzas/App",
  statement: "02-Areas/Finanzas/App",
  review: "99-Meta/Revisiones",
};
export const native = new Set([
  "id",
  "kind",
  "title",
  "body",
  "version",
  "createdAt",
  "updatedAt",
  "deleted",
  "vaultPath",
  "sourceLine",
  "sourceKind",
  "validationErrors",
  "status",
  "tags",
  "area",
  "verifiedAt",
  "expiresAt",
  "lastMutation",
]);
export const fields = [
  "date",
  "endDate",
  "time",
  "endTime",
  "timezone",
  "projectId",
  "priority",
  "plannedDate",
  "recurrence",
  "recurrenceDay",
  "accountType",
  "currency",
  "accountId",
  "otherAccountId",
  "transactionType",
  "amountMinor",
  "category",
  "startsAt",
  "endsAt",
  "minimumMinor",
  "noInterestMinor",
  "statementBalanceMinor",
  "installments",
  "dueDate",
  "checked",
  "source",
  "sourceHash",
  "externalId",
];
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function split(text) {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const doc = m
    ? parseDocument(m[1], { keepSourceTokens: true, uniqueKeys: true })
    : new Document({});
  const body = m ? text.slice(m[0].length) : text;
  return { doc, body, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}
export function plain(doc) {
  const ancestors = new WeakSet();
  const convert = (value) => {
    if (!value || typeof value !== "object") return value;
    if (ancestors.has(value)) throw new Error("Cyclic YAML metadata");
    ancestors.add(value);
    let output;
    if (value instanceof Map) {
      output = Object.create(null);
      for (const [key, entry] of value)
        if (typeof key === "string") output[key] = convert(entry);
    } else if (Array.isArray(value)) output = value.map(convert);
    else output = value;
    ancestors.delete(value);
    return output;
  };
  try {
    const object = convert(doc.toJS({ maxAliasCount: 50, mapAsMap: true }));
    return object && typeof object === "object" && !Array.isArray(object)
      ? object
      : {};
  } catch {
    return {};
  }
}
export const displayText = (value) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
export const dateString = (v) => (typeof v === "string" ? v : undefined);
export const cleanTitle = (s) =>
  s
    .replace(/<!--\s*sb-task:[\s\S]*?-->/g, "")
    .replace(/\s+\^[\w-]+\s*$/, "")
    .replace(/\s*(?:📅|⏳)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .trim();
export function day(v) {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v + "T12:00:00Z")) &&
    new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v
  );
}
