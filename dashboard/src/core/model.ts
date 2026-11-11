export type Kind =
  | "task"
  | "inbox"
  | "project"
  | "note"
  | "event"
  | "account"
  | "transaction"
  | "obligation"
  | "review"
  | "notification"
  | "statement";
export interface Item {
  id: string;
  kind: Kind;
  title: string;
  version: number | string;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
  body?: string;
  status?: string;
  date?: string;
  endDate?: string;
  time?: string;
  endTime?: string;
  timezone?: string;
  projectId?: string;
  area?: string;
  priority?: boolean;
  plannedDate?: string;
  recurrence?: string;
  source?: string;
  verifiedAt?: string;
  expiresAt?: string;
  tags?: string[];
  accountType?: string;
  currency?: string;
  accountId?: string;
  otherAccountId?: string;
  transactionType?: string;
  amountMinor?: number;
  category?: string;
  startsAt?: string;
  endsAt?: string;
  recurrenceDay?: number;
  minimumMinor?: number;
  noInterestMinor?: number;
  statementBalanceMinor?: number;
  installments?: number;
  dueDate?: string;
  checked?: string[];
  vaultPath?: string;
  sourceLine?: number;
  sourceKind?: string;
  validationErrors?: string[];
  sourceHash?: string;
  externalId?: string;
}
/** Structured finance document; shown in Finanzas, hidden from the notes list. */
export const FINANCE_PATH = "02-Areas/Finanzas/Datos-financieros.md";
export const uid = () => crypto.randomUUID();
export const localDay = (date = new Date(), zone = "America/Mexico_City") =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export const today = () =>
  localDay(
    new Date(),
    localStorage.getItem("sb-zone") || "America/Mexico_City",
  );
export const shiftDay = (day: string, offset: number) => {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
export const dateLabel = (
  day?: string,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
) => {
  if (!day) return "Sin fecha";
  const value = new Date(day + "T12:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(value.getTime()) ||
    value.toISOString().slice(0, 10) !== day
  )
    return "Fecha por revisar";
  return new Intl.DateTimeFormat("es-MX", { ...opts, timeZone: "UTC" }).format(
    value,
  );
};
export const money = (minor = 0) =>
  Number.isFinite(minor)
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
      }).format(minor / 100)
    : "Importe por revisar";
export const newItem = (kind: Kind, data: Partial<Item> = {}): Item => ({
  id: uid(),
  kind,
  title: "",
  version: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...data,
});
export const active = (items: Item[], kind: Kind) =>
  items.filter((x) => x.kind === kind && !x.deleted);
export const projectName = (items: Item[], id?: string) =>
  items.find((x) => x.id === id)?.title;
export function parseAmount(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim()))
    throw new Error("Escribe un importe válido con hasta dos decimales.");
  const [whole, decimal = ""] = value.trim().split(".");
  const n = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1_000_000_000)
    throw new Error("El importe está fuera de rango.");
  return n;
}
export function balance(items: Item[], id: string): number {
  let result = 0;
  for (const t of active(items, "transaction").filter(
    (t) =>
      t.status !== "pending" &&
      t.status !== "draft" &&
      !t.validationErrors?.length,
  )) {
    const n = t.amountMinor || 0;
    if (t.accountId === id)
      result += ["income", "refund", "opening"].includes(
        t.transactionType || "",
      )
        ? n
        : -n;
    if (t.otherAccountId === id) result += n;
  }
  return result;
}
export function expenses(items: Item[], month = today().slice(0, 7)): number {
  return active(items, "transaction")
    .filter(
      (t) =>
        t.status !== "pending" &&
        t.status !== "draft" &&
        !t.validationErrors?.length &&
        t.date?.startsWith(month),
    )
    .reduce(
      (n, t) =>
        n +
        (t.transactionType === "expense"
          ? t.amountMinor || 0
          : t.transactionType === "refund"
            ? -(t.amountMinor || 0)
            : 0),
      0,
    );
}
export function nextOccurrence(
  day: string,
  rule: string,
  anchor?: number,
): string {
  if (rule === "daily") return shiftDay(day, 1);
  if (rule === "weekly") return shiftDay(day, 7);
  const d = new Date(day + "T12:00:00Z");
  const original = anchor || d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(original, end));
  return d.toISOString().slice(0, 10);
}
export const nav = [
  { path: "/", label: "Sala", icon: "Box" },
  { path: "/tasks", label: "Tareas", icon: "CircleCheck" },
  { path: "/projects", label: "Proyectos", icon: "Layers" },
  { path: "/finance", label: "Finanzas", icon: "Wallet" },
];

export function eventInZone(event: Item): Item {
  if (!event.time || !event.startsAt) return event;
  const zone = localStorage.getItem("sb-zone") || "America/Mexico_City";
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt || event.startsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return event;
  const time = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  return {
    ...event,
    date: localDay(start, zone),
    endDate: localDay(end, zone),
    time: time(start),
    endTime: time(end),
  };
}

export const shiftMonth = (day: string, offset: number) => {
  const d = new Date(day + "T12:00:00Z");
  const anchor = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  d.setUTCDate(
    Math.min(
      anchor,
      new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    ),
  );
  return d.toISOString().slice(0, 10);
};
export function occursOn(event: Item, day: string): boolean {
  if (!event.date || event.date > day) return false;
  const end = event.endDate || event.date;
  if (event.time)
    return (
      end > day ||
      (end === day && (event.endTime !== "00:00" || event.date === day))
    );
  return (event.endDate || shiftDay(event.date, 1)) > day;
}

export const privateMoney = (minor?: number) =>
  localStorage.getItem("sb-hide-money") === "true" ? "••••••" : money(minor);
