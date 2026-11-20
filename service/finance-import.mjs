// One-time importer for the dated "Registro financiero" note (tables exported
// from the card summary). It only reads Markdown text; the caller decides
// whether to write the result.
import { Failure } from "./vault.mjs";
import { emptyFinance, toMinor, isDay, addDays } from "./finance.mjs";
/** @import { FinanceTransaction, FinanceTransactionType } from "./finance-types.d.ts" */

/** @type {Record<string, number | undefined>} */
const MONTHS = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};
/** @param {unknown} s */
const norm = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
/** @param {string} s */
const slug = (s) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** @param {string} markdown @param {RegExp} headingPattern */
function tableAfter(markdown, headingPattern) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (l) => /^#{2,4}\s/.test(l) && headingPattern.test(l),
  );
  if (start < 0) return { heading: "", rows: [] };
  /** @type {Record<string, string>[]} */
  const rows = [];
  /** @type {string[] | undefined} */
  let header;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,4}\s/.test(line)) break;
    if (!line.startsWith("|")) {
      if (header && rows.length) break;
      continue;
    }
    const cells = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) header = cells.map(norm);
    else
      rows.push(Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""])));
  }
  return { heading: lines[start], rows };
}
/** @param {string} cell */
const money = (cell) =>
  toMinor(
    String(cell)
      .replace(/^\$\s*/, "")
      .replace(/^\$-/, "-")
      .replace(/^-\$/, "-"),
    "importe",
  );

/** @param {string} day @param {string} month @param {number} asOfYear @param {number | undefined} endMonth */
function cycleDate(day, month, asOfYear, endMonth) {
  // Callers only pass month names matched by the MONTHS regex.
  const m = /** @type {number} */ (MONTHS[month]);
  let year = asOfYear;
  if (endMonth && m > endMonth) year -= 1;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** @param {string} markdown @param {string} today */
export function parseRegistro(markdown, today) {
  const asOf = markdown.match(/exportado\s+(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!isDay(asOf))
    throw new Failure(
      "No se encontró la fecha del exportado (exportado AAAA-MM-DD).",
    );
  const year = Number(asOf.slice(0, 4));
  const data = emptyFinance(asOf);
  data.source = "Registro financiero exportado " + asOf;

  const indicators = Object.fromEntries(
    tableAfter(markdown, /Indicadores/).rows.map((r) => [
      norm(r.indicador),
      r.valor,
    ]),
  );
  if (indicators.ingreso_mensual_referencia)
    data.incomeMonthlyMinor = toMinor(
      indicators.ingreso_mensual_referencia,
      "ingreso",
    );

  for (const r of tableAfter(markdown, /Tarjetas/).rows) {
    if (!r.tarjeta) continue;
    const range = r.ciclo.match(/(\d+)\s+(\w{3})\s*-\s*(\d+)\s+(\w{3})/);
    const cutDay = Number(r["corte (dia)"]);
    const endMonth = range ? MONTHS[range[4].toLowerCase()] : undefined;
    const cutDate = endMonth
      ? `${year}-${String(endMonth).padStart(2, "0")}-${String(cutDay).padStart(2, "0")}`
      : undefined;
    data.cards.push({
      id: slug(r.tarjeta),
      name: r.tarjeta,
      last4: r["ultimos 4"],
      limitMinor: money(r.limite),
      balanceMinor: money(r.saldo),
      payMinor: money(r["a pagar"]),
      payNote:
        "Sin confirmar si es pago para no generar intereses, mínimo u otra estimación.",
      cutDate,
      cycleStart: range
        ? cycleDate(range[1], range[2].toLowerCase(), year, endMonth)
        : undefined,
      dueDate: r["fecha limite"],
      dueEstimated: /estimad/i.test(r.nota),
      note: r.nota || undefined,
      asOf,
    });
  }
  /** @param {string} name */
  const cardOf = (name) =>
    data.cards.find((c) => norm(c.name) === norm(name))?.id;

  let n = 0;
  for (const r of tableAfter(markdown, /Movimientos/).rows) {
    if (!r.id || !r.fecha) continue;
    const type =
      /** @type {Record<string, FinanceTransactionType | undefined>} */ ({
        cargo: "charge",
        pago: "payment",
        cashback: "cashback",
        reversa: "reversal",
      })[norm(r.tipo)];
    const card = cardOf(r.tarjeta);
    if (!type || !card)
      throw new Failure(`Movimiento ${r.id}: tipo o tarjeta desconocidos.`);
    /** @type {FinanceTransaction} */
    const tx = {
      id: r.id,
      date: r.fecha,
      card,
      desc: r["descripcion"].replace(/\s*\(en proceso\)$/i, ""),
      category: r["categoria"],
      amountMinor: money(r.monto),
      type,
      status: /proceso/i.test(r.estado) ? "pending" : "posted",
    };
    if (r.nota) tx.note = r.nota;
    data.transactions.push(tx);
    n++;
  }
  if (!n) throw new Failure("No se encontraron movimientos en el registro.");

  const cashRows = tableAfter(markdown, /Flujo de efectivo/).rows;
  let c = 0;
  let k = 0;
  for (const r of cashRows) {
    const group = norm(r.grupo);
    const label = r.concepto;
    if (group === "entradas") {
      data.cash.push({
        id: "e" + String(++c).padStart(2, "0"),
        label,
        kind: /ahorro/i.test(label) ? "savings" : "income",
        amountMinor: money(r.monto),
        recurring: false,
      });
    } else if (group === "comprometido" && !/a meses/i.test(label)) {
      const hit = [...data.transactions]
        .reverse()
        .find(
          (t) =>
            norm(t.desc).includes(norm(label)) ||
            norm(label).includes(norm(t.desc)),
        );
      data.commitments.push({
        id: "c" + String(++k).padStart(2, "0"),
        label,
        amountMinor: money(r.monto),
        card: hit?.card,
      });
    }
  }

  const inst = tableAfter(markdown, /Mensualidades/);
  const instCard = cardOf(inst.heading.match(/,\s*([^)]+)\)/)?.[1] || "");
  let m = 0;
  for (const r of inst.rows) {
    if (!r.compra) continue;
    data.installments.push({
      id: "m" + String(++m).padStart(2, "0"),
      label: r.compra,
      card: instCard,
      originalMinor: money(r.original),
      months: Number(r.meses),
      monthlyMinor: money(r["pago mensual"]),
      paid: Number(r["pagos hechos"]),
      remainingMinor: money(r["saldo pendiente"]),
      estimated: /true/i.test(r["monto estimado"]),
    });
  }

  return {
    data,
    expected: {
      cycleChargesMinor: indicators.cargos_netos_ciclo_actual
        ? toMinor(indicators.cargos_netos_ciclo_actual, "cargos")
        : undefined,
      usedMinor: indicators.credito_usado
        ? toMinor(indicators.credito_usado, "crédito")
        : undefined,
      payMinor: indicators.por_pagar_tarjetas
        ? toMinor(indicators.por_pagar_tarjetas, "por pagar")
        : undefined,
      marginMinor: indicators.margen_tras_compromisos
        ? toMinor(indicators.margen_tras_compromisos, "margen")
        : undefined,
    },
    asOf,
    expires: addDays(asOf, data.validityDays),
    today,
  };
}
