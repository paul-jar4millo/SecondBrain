import { type Item, parseAmount, today, shiftDay } from "../core/model";
/** Validate an editable value before it reaches persistence. */
export function editorValue(
  item: Item,
  amount: string,
  statementAmounts: Record<string, string>,
): Item {
  const kind = item.kind;
  const result = { ...item, title: item.title.trim() };
  if (!result.title) throw new Error("Añade un título.");
  if (["transaction", "obligation", "statement"].includes(kind) && amount)
    result.amountMinor = parseAmount(amount);
  if (kind === "transaction") {
    if (!result.amountMinor) throw new Error("Añade un importe.");
    if (!result.accountId) throw new Error("Elige la cuenta.");
    result.date ||= today();
    result.status ||= "confirmed";
    result.transactionType ||= "expense";
    if (
      ["payment", "transfer"].includes(result.transactionType) &&
      (!result.otherAccountId || result.otherAccountId === result.accountId)
    )
      throw new Error("Elige una cuenta de destino distinta.");
  }
  if (kind === "event") {
    if (!result.date) throw new Error("Elige una fecha.");
    result.endDate ||= result.time ? result.date : shiftDay(result.date, 1);
    if (!result.time && result.endDate <= result.date)
      throw new Error(
        "El fin de un evento de día completo es el día siguiente o posterior.",
      );
    if (result.time && !result.endTime)
      throw new Error("Añade una hora de fin.");
    if (
      result.time &&
      `${result.endDate}T${result.endTime}` <= `${result.date}T${result.time}`
    )
      throw new Error("El fin debe ser posterior al inicio.");
    result.timezone ||=
      localStorage.getItem("sb-zone") || "America/Mexico_City";
  }
  if (kind === "statement") {
    for (const [key, value] of Object.entries(statementAmounts)) {
      if (value.trim() !== "")
        (result as unknown as Record<string, unknown>)[key] =
          value.trim() === "0" ? 0 : parseAmount(value);
    }
    if (!result.accountId || !result.date || !result.dueDate)
      throw new Error("Indica cuenta, corte y vencimiento.");
  }
  if (kind === "account") {
    result.accountType ||= "asset";
    result.currency = "MXN";
  }
  if (kind === "task") result.status ||= "pending";
  if (kind === "project") result.status ||= "active";
  return result;
}
