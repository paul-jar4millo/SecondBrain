import { Temporal } from "@js-temporal/polyfill";
import { kinds, uuid, day } from "./vault-format.mjs";
/** @param {any[] | Map<string, any>} items */
export const accountIndex = (items) =>
  items instanceof Map
    ? items
    : new Map(
        items
          .filter((a) => a.kind === "account" && !a.deleted)
          .map((a) => [a.id, a]),
      );
/**
 * @param {any} item
 * @param {any[] | Map<string, any>} [items] Records, or an index from accountIndex().
 */
export function validate(item, items = []) {
  const errors = [];
  if (!uuid.test(item.id || "")) errors.push("Identificador inválido.");
  if (!kinds.has(item.kind)) errors.push("Tipo de registro no admitido.");
  if (
    typeof item.title !== "string" ||
    !item.title.trim() ||
    item.title.length > 500
  )
    errors.push("El título debe tener de 1 a 500 caracteres.");
  else if (/[\r\n]/.test(item.title))
    errors.push("El título no puede tener saltos de línea.");
  if (
    item.body !== undefined &&
    (typeof item.body !== "string" || item.body.length > 500000)
  )
    errors.push("El contenido supera el límite.");
  for (const key of [
    "date",
    "endDate",
    "plannedDate",
    "verifiedAt",
    "expiresAt",
    "dueDate",
  ])
    if (item[key] && !day(item[key])) errors.push("Fecha inválida: " + key);
  if (item.kind === "transaction") {
    if (
      !Number.isSafeInteger(item.amountMinor) ||
      item.amountMinor <= 0 ||
      item.amountMinor > 1e9
    )
      errors.push("El importe debe ser un entero positivo en centavos.");
    if (
      ![
        "expense",
        "income",
        "payment",
        "transfer",
        "refund",
        "opening",
        "opening_debt",
      ].includes(item.transactionType)
    )
      errors.push("Tipo financiero inválido.");
    const account = accountIndex(items).get(item.accountId);
    const other = accountIndex(items).get(item.otherAccountId);
    if (!account || !["asset", "credit"].includes(account.accountType))
      errors.push("La cuenta de origen no existe o su tipo es inválido.");
    if (!day(item.date)) errors.push("El movimiento necesita fecha.");
    if (item.status !== "confirmed")
      errors.push("Solo se contabilizan movimientos confirmados.");
    if (
      ["transfer", "payment"].includes(item.transactionType) &&
      (!other || other.id === account?.id)
    )
      errors.push("Elige dos cuentas distintas.");
    if (
      item.transactionType === "payment" &&
      (account?.accountType !== "asset" || other?.accountType !== "credit")
    )
      errors.push("Un pago de tarjeta va de débito/efectivo a crédito.");
    if (
      item.transactionType === "transfer" &&
      (account?.accountType !== "asset" || other?.accountType !== "asset")
    )
      errors.push("Una transferencia necesita dos cuentas de activo.");
    if (
      item.transactionType === "opening_debt" &&
      account?.accountType !== "credit"
    )
      errors.push("La deuda inicial corresponde a una cuenta de crédito.");
    if (item.currency && item.currency !== "MXN")
      errors.push("Esta versión opera en MXN.");
  }
  if (
    ["account", "transaction", "statement"].includes(item.kind) &&
    item.currency &&
    item.currency !== "MXN"
  )
    errors.push("La moneda debe ser MXN.");
  if (
    item.kind === "account" &&
    !["asset", "credit"].includes(item.accountType)
  )
    errors.push("Tipo de cuenta inválido.");
  if (
    item.kind === "task" &&
    item.recurrence &&
    !["daily", "weekly", "monthly"].includes(item.recurrence)
  )
    errors.push("Recurrencia desconocida.");
  if (item.kind === "event") {
    if (!day(item.date) || !day(item.endDate))
      errors.push("El evento necesita fechas de inicio y fin.");
    else if (!item.time) {
      if (item.endDate <= item.date)
        errors.push("El fin de un evento de día completo es exclusivo.");
    } else {
      try {
        const start = Temporal.ZonedDateTime.from(
          `${item.date}T${item.time}[${item.timezone || "America/Mexico_City"}]`,
          { disambiguation: "reject" },
        );
        const end = Temporal.ZonedDateTime.from(
          `${item.endDate}T${item.endTime}[${item.timezone || "America/Mexico_City"}]`,
          { disambiguation: "reject" },
        );
        if (end.epochMilliseconds <= start.epochMilliseconds)
          errors.push("El fin debe ser posterior al inicio.");
        else {
          item.startsAt = start.toInstant().toString();
          item.endsAt = end.toInstant().toString();
        }
      } catch {
        errors.push(
          "Hora o zona inválida/ambigua durante un cambio de horario.",
        );
      }
    }
  }
  if (item.kind === "statement") {
    if (!day(item.date) || !day(item.dueDate))
      errors.push("El corte y el vencimiento deben ser fechas explícitas.");
    for (const key of [
      "minimumMinor",
      "noInterestMinor",
      "statementBalanceMinor",
    ])
      if (
        item[key] !== undefined &&
        (!Number.isSafeInteger(item[key]) || item[key] < 0)
      )
        errors.push("Importe de corte inválido: " + key);
  }
  return errors;
}
