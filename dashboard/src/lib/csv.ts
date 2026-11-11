import { newItem, parseAmount, type Item } from "../core/model";
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const source = text.replace(/^\uFEFF/, "");
  let first = source.split(/\r?\n/)[0];
  const delimiter =
    first.split(";").length > first.split(",").length ? ";" : ",";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"' && !cell && !closed) {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
      closed = false;
    } else {
      if (closed && c.trim())
        throw new Error(
          "CSV inválido: caracteres después de una comilla de cierre.",
        );
      cell += c;
    }
  }
  if (quoted) throw new Error("CSV inválido: una comilla no está cerrada.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length > 10001)
    throw new Error("El máximo es 10,000 filas por lote.");
  if (rows.length < 2)
    throw new Error("El CSV necesita encabezados y al menos un movimiento.");
  if (rows.some((r) => r.length !== rows[0].length))
    throw new Error("Hay filas con un número de columnas distinto.");
  return rows;
}
export interface CSVMapping {
  date: number;
  title: number;
  amount: number;
  account: number;
  type: number;
  category: number;
  otherAccount: number;
  defaultAccount: string;
  defaultType: string;
  dateFormat: string;
  decimal: string;
}
export async function csvItems(
  rows: string[][],
  mapping: CSVMapping,
  accounts: Item[],
): Promise<Item[]> {
  const encoded = new TextEncoder().encode(JSON.stringify(rows));
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const types: Record<string, string> = {
    expense: "expense",
    gasto: "expense",
    income: "income",
    ingreso: "income",
    payment: "payment",
    pago: "payment",
    transfer: "transfer",
    transferencia: "transfer",
    refund: "refund",
    devolución: "refund",
    opening: "opening",
    opening_debt: "opening_debt",
  };
  return rows.slice(1).map((r, i) => {
    const rawDate = r[mapping.date]?.trim();
    let date = "";
    if (mapping.dateFormat === "ISO") date = rawDate;
    else {
      const parts = rawDate?.split(/[\/.-]/);
      if (parts?.length === 3)
        date =
          parts[2] +
          "-" +
          (mapping.dateFormat === "DMY" ? parts[1] : parts[0]).padStart(
            2,
            "0",
          ) +
          "-" +
          (mapping.dateFormat === "DMY" ? parts[0] : parts[1]).padStart(2, "0");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw new Error(
        `Fila ${i + 2}: la fecha no es válida para el formato elegido.`,
      );
    let value = r[mapping.amount]?.trim().replace(/[$\s]/g, "") || "";
    if (mapping.decimal === ",")
      value = value.replaceAll(".", "").replace(",", ".");
    else value = value.replaceAll(",", "");
    if (value.startsWith("-"))
      throw new Error(
        `Fila ${i + 2}: el importe es negativo. Convierte a importe positivo e indica el tipo de operación explícitamente.`,
      );
    const amountMinor = parseAmount(value);
    const title = r[mapping.title]?.trim();
    if (!title) throw new Error(`Fila ${i + 2}: falta el concepto.`);
    const account =
      mapping.account >= 0
        ? accounts.find(
            (a) =>
              a.title.toLocaleLowerCase() ===
              r[mapping.account]?.trim().toLocaleLowerCase(),
          )?.id
        : mapping.defaultAccount;
    if (!account)
      throw new Error(
        `Fila ${i + 2}: no se encontró la cuenta. Créala primero o elige una cuenta para el lote.`,
      );
    const type =
      mapping.type >= 0
        ? types[r[mapping.type]?.trim().toLocaleLowerCase()]
        : mapping.defaultType;
    if (!type) throw new Error(`Fila ${i + 2}: tipo de operación desconocido.`);
    const other =
      mapping.otherAccount >= 0
        ? accounts.find((a) => a.title === r[mapping.otherAccount]?.trim())?.id
        : undefined;
    if (["payment", "transfer"].includes(type) && !other)
      throw new Error(
        `Fila ${i + 2}: los pagos y transferencias necesitan una columna con la cuenta de destino.`,
      );
    const h = digest.slice(0, 24) + i.toString(16).padStart(8, "0");
    const id =
      h.slice(0, 8) +
      "-" +
      h.slice(8, 12) +
      "-4" +
      h.slice(13, 16) +
      "-a" +
      h.slice(17, 20) +
      "-" +
      h.slice(20, 32);
    return newItem("transaction", {
      id,
      title,
      date,
      accountId: account,
      otherAccountId: other,
      transactionType: type,
      amountMinor,
      category: mapping.category >= 0 ? r[mapping.category] : undefined,
      status: "confirmed",
      source: "CSV:" + digest,
      externalId: digest + ":" + i,
    });
  });
}
