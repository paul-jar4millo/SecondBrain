import { Failure } from "./vault.mjs";
/** @import { FinanceCard, FinanceData, FinanceHandler, FinanceInstallment, FinanceOperation, FinanceTransaction, FinanceTransactionType } from "./finance-types.d.ts" */
const LEAK_DEFAULT = ["Comida fuera", "Rappi", "Antojos y conveniencia"];
export const UNIDENTIFIED = "Sin identificar";
/* ---------- small pure helpers ---------- */
export const mexicoDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ_APP || "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
/** @param {unknown} v @returns {v is string} */
export const isDay = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + "T12:00:00Z")) &&
  new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;
/** @param {string} day @param {number} n */
export const addDays = (day, n) => {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** @param {string} a @param {string} b */
export const diffDays = (a, b) =>
  Math.round(
    (Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5,
  );
/** @param {string} day */
const monthBack = (day) => {
  const d = new Date(day + "T12:00:00Z");
  const anchor = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(anchor, end));
  return d.toISOString().slice(0, 10);
};
/** @param {unknown} s */
const norm = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
/** @param {string} s */
const slug = (s) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Accepts pesos ("1,234.50", 1234.5) and returns integer centavos.
 * @param {unknown} value
 */
export function toMinor(value, label = "importe") {
  if (typeof value === "number") {
    const cents = Math.round(value * 100);
    if (!Number.isFinite(value) || Math.abs(value * 100 - cents) > 1e-6)
      throw new Failure(`El ${label} admite hasta dos decimales.`);
    return cents;
  }
  const text = String(value ?? "")
    .replace(/[$,\s]/g, "")
    .trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text))
    throw new Failure(`El ${label} no es válido: "${value}".`);
  const negative = text.startsWith("-");
  const [whole, decimals = ""] = text.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 1e10)
    throw new Failure(`El ${label} está fuera de rango.`);
  return negative ? -cents : cents;
}
/** @param {FinanceOperation} op @param {string} key @param {string} label */
const minorOf = (op, key, label) => {
  const n =
    op[key + "Minor"] !== undefined
      ? Number(op[key + "Minor"])
      : toMinor(op[key], label);
  if (!Number.isSafeInteger(n)) throw new Failure(`El ${label} no es válido.`);
  return n;
};
/** @param {FinanceOperation} op @param {string} key @param {string} label */
const amountOf = (op, key, label) => {
  const n = minorOf(op, key, label);
  if (n <= 0) throw new Failure(`El ${label} debe ser mayor que cero.`);
  return n;
};
/** @param {FinanceOperation} op @param {string} key */
const has = (op, key) =>
  op[key] !== undefined || op[key + "Minor"] !== undefined;
/** @param {unknown} value @param {string} label */
const text = (value, label, max = 200) => {
  const s = String(value ?? "").trim();
  if (!s) throw new Failure(`Falta ${label}.`);
  if (s.length > max) throw new Failure(`${label} supera ${max} caracteres.`);
  return s;
};
/** @param {unknown} value @param {string} [fallback] */
const dayOf = (value, fallback, label = "fecha") => {
  const d = value ?? fallback;
  if (!isDay(d)) throw new Failure(`La ${label} debe ser AAAA-MM-DD.`);
  return d;
};

/* ---------- data shape ---------- */
/** @param {string} today @returns {FinanceData} */
export function emptyFinance(today) {
  return {
    schemaVersion: 1,
    currency: "MXN",
    reconciledAt: today,
    validityDays: 7,
    staleAfterDays: 3,
    incomeMonthlyMinor: 0,
    leakCategories: [...LEAK_DEFAULT],
    cards: [],
    cash: [],
    commitments: [],
    installments: [],
    transactions: [],
    questions: [],
  };
}
/** @param {unknown} raw @returns {FinanceData} */
export function normalize(raw) {
  // Legacy documents are normalized shallowly and retain additional fields.
  const f = /** @type {Partial<FinanceData>} */ (
    raw && typeof raw === "object" ? raw : {}
  );
  /** @template T @param {T[] | undefined} v @returns {T[]} */
  const list = (v) =>
    Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  return {
    ...f,
    schemaVersion: 1,
    currency: "MXN",
    validityDays: Number.isFinite(f.validityDays) ? f.validityDays : 7,
    staleAfterDays: Number.isFinite(f.staleAfterDays) ? f.staleAfterDays : 3,
    incomeMonthlyMinor: Number.isFinite(f.incomeMonthlyMinor)
      ? f.incomeMonthlyMinor
      : 0,
    leakCategories: Array.isArray(f.leakCategories)
      ? f.leakCategories
      : [...LEAK_DEFAULT],
    cards: list(f.cards),
    cash: list(f.cash),
    commitments: list(f.commitments),
    installments: list(f.installments),
    transactions: list(f.transactions),
    questions: list(f.questions),
  };
}

/* ---------- derived overview ---------- */
/** @template T @param {T[]} xs @param {(item: T) => number} f */
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
/** @param {FinanceTransaction} t */
const spendsIn = (t) => t.type === "charge" || t.type === "reversal";
/** @param {FinanceCard} card */
function cycleWindow(card) {
  const end = isDay(card.cutDate) ? card.cutDate : undefined;
  const start = isDay(card.cycleStart)
    ? card.cycleStart
    : end
      ? addDays(monthBack(end), 1)
      : undefined;
  return { start, end };
}
/** @param {FinanceInstallment} i */
export function installmentView(i) {
  const months = Number(i.months) || 0;
  const paid = Math.min(Number(i.paid) || 0, months);
  const left = Math.max(0, months - paid);
  const monthlyMinor = Number(i.monthlyMinor) || 0;
  const remainingMinor = Number.isFinite(i.remainingMinor)
    ? i.remainingMinor
    : monthlyMinor * left;
  return {
    ...i,
    months,
    paid,
    left,
    monthlyMinor,
    remainingMinor,
    done: left === 0,
  };
}

/** @param {unknown} rawData @param {string} today */
export function overview(rawData, today) {
  const data = normalize(rawData);
  const cardName = new Map(data.cards.map((c) => [c.id, c.name]));
  const txs = data.transactions
    .map((t) => ({ ...t, cardName: cardName.get(t.card) || t.card }))
    .sort(
      (a, b) =>
        (b.date || "").localeCompare(a.date || "") ||
        String(b.id).localeCompare(String(a.id), "en", { numeric: true }),
    );

  const cards = data.cards.map((c) => {
    const { start, end } = cycleWindow(c);
    const cycleTxs = txs.filter(
      (t) =>
        t.card === c.id &&
        spendsIn(t) &&
        start &&
        end &&
        t.date >= start &&
        t.date <= end,
    );
    const cycleChargesMinor = sum(cycleTxs, (t) => t.amountMinor || 0);
    const limitMinor = c.limitMinor || 0;
    const balanceMinor = c.balanceMinor || 0;
    const asOf = isDay(c.asOf) ? c.asOf : undefined;
    return {
      id: c.id,
      name: c.name,
      last4: c.last4,
      note: c.note,
      limitMinor,
      balanceMinor,
      availableMinor: limitMinor - balanceMinor,
      usedPct: limitMinor ? balanceMinor / limitMinor : 0,
      payMinor: c.payMinor,
      payNote: c.payNote,
      cutDate: isDay(c.cutDate) ? c.cutDate : undefined,
      cutNote: c.cutNote,
      dueDate: isDay(c.dueDate) ? c.dueDate : undefined,
      dueEstimated: c.dueEstimated !== false,
      cycleStart: start,
      cycleEnd: end,
      cycleChargesMinor,
      daysToCut: isDay(c.cutDate) ? diffDays(c.cutDate, today) : undefined,
      daysToDue: isDay(c.dueDate) ? diffDays(c.dueDate, today) : undefined,
      asOf,
      ageDays: asOf ? diffDays(today, asOf) : undefined,
      stale: asOf ? diffDays(today, asOf) > data.staleAfterDays : true,
      cutPassed: isDay(c.cutDate) ? c.cutDate < today : false,
    };
  });

  const inflows = data.cash.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind || "income",
    amountMinor: c.amountMinor || 0,
    recurring: c.recurring === true,
    available: c.available,
    note: c.note,
  }));
  const installments = data.installments.map(installmentView);
  const activeInstallments = installments.filter((i) => !i.done);
  const commitments = data.commitments.map((c) => ({
    id: c.id,
    label: c.label,
    amountMinor: c.amountMinor || 0,
    card: c.card,
    cardName: cardName.get(c.card),
    dayOfMonth: c.dayOfMonth,
    note: c.note,
  }));
  const installmentsMonthlyMinor = sum(
    activeInstallments,
    (i) => i.monthlyMinor,
  );
  const fixedMinor = sum(commitments, (c) => c.amountMinor);
  const inflowsMinor = sum(inflows, (c) => c.amountMinor);
  const payMinor = sum(cards, (c) => c.payMinor || 0);
  const payUnknown = cards
    .filter((c) => c.payMinor === undefined)
    .map((c) => c.name);
  const marginMinor =
    inflowsMinor - payMinor - installmentsMonthlyMinor - fixedMinor;

  /** @type {Map<string, number>} */
  const catMap = new Map();
  for (const c of cards)
    for (const t of txs.filter(
      (t) =>
        t.card === c.id &&
        spendsIn(t) &&
        c.cycleStart &&
        c.cycleEnd &&
        t.date >= c.cycleStart &&
        t.date <= c.cycleEnd,
    ))
      catMap.set(
        t.category || UNIDENTIFIED,
        (catMap.get(t.category || UNIDENTIFIED) || 0) + t.amountMinor,
      );
  const income = data.incomeMonthlyMinor;
  const categories = [...catMap.entries()]
    .map(([category, amountMinor]) => ({
      category,
      amountMinor,
      pctOfIncome: income ? amountMinor / income : undefined,
    }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
  const cycleChargesMinor = sum(cards, (c) => c.cycleChargesMinor);

  const since = addDays(today, -30);
  const leakRows = data.leakCategories.map((category) => {
    const amountMinor = sum(
      txs.filter(
        (t) =>
          spendsIn(t) &&
          t.category === category &&
          t.date > since &&
          t.date <= today,
      ),
      (t) => t.amountMinor,
    );
    return { category, amountMinor };
  });
  const leakMinor = sum(leakRows, (r) => r.amountMinor);

  const unidentified = txs.filter(
    (t) => spendsIn(t) && (!t.category || t.category === UNIDENTIFIED),
  );
  const pendingTxs = txs.filter((t) => t.status === "pending");

  /** @type {Array<{ date: string, type: "cut" | "due", label: string, card: string, estimated: boolean, amountMinor?: number, overdue?: boolean }>} */
  const upcoming = [];
  for (const c of cards) {
    if (c.cutDate && c.cutDate >= today)
      upcoming.push({
        date: c.cutDate,
        type: "cut",
        label: `Corte ${c.name}`,
        card: c.id,
        estimated: false,
      });
    if (c.dueDate && c.dueDate >= addDays(today, -7))
      upcoming.push({
        date: c.dueDate,
        type: "due",
        label: `Fecha límite ${c.name}`,
        card: c.id,
        amountMinor: c.payMinor,
        estimated: c.dueEstimated,
        overdue: c.dueDate < today,
      });
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  /** @type {Array<{ level: "info" | "warning" | "danger", code: string, text: string, card?: string }>} */
  const alerts = [];
  /** @param {number} n */
  const fmt = (n) =>
    new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
    }).format(n / 100);
  /** @param {string} d */
  const longDay = (d) =>
    new Intl.DateTimeFormat("es-MX", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(d + "T12:00:00Z"));
  const expiresAt = isDay(data.reconciledAt)
    ? addDays(data.reconciledAt, data.validityDays)
    : undefined;
  const expired = expiresAt ? expiresAt < today : true;
  if (expired)
    alerts.push({
      level: "warning",
      code: "expired",
      text: `Los datos caducaron${expiresAt ? " el " + longDay(expiresAt) : ""}: pide a un agente que los actualice antes de usarlos.`,
    });
  for (const c of cards) {
    if (c.stale && c.asOf)
      alerts.push({
        level: "info",
        code: "stale-card",
        card: c.id,
        text: `${c.name}: saldo al ${longDay(c.asOf)}, sin actualizar hace ${c.ageDays} días.`,
      });
    if (c.cutPassed)
      alerts.push({
        level: "warning",
        code: "cut-passed",
        card: c.id,
        text: `El corte de ${c.name} (${longDay(c.cutDate)}) ya pasó: falta el nuevo estado de cuenta.`,
      });
    if (c.daysToDue !== undefined && c.daysToDue < 0)
      alerts.push({
        level: "danger",
        code: "overdue",
        card: c.id,
        text: `La fecha límite de ${c.name} (${longDay(c.dueDate)}) ya pasó; confirma si se pagó.`,
      });
    else if (c.daysToDue !== undefined && c.daysToDue <= 7)
      alerts.push({
        level: "warning",
        code: "due-soon",
        card: c.id,
        text: `${c.name} vence en ${c.daysToDue} días (${longDay(c.dueDate)})${c.dueEstimated ? ", fecha estimada" : ""}.`,
      });
  }
  if (unidentified.length)
    alerts.push({
      level: "info",
      code: "unidentified",
      text: `${unidentified.length} cargo(s) sin identificar por ${fmt(sum(unidentified, (t) => t.amountMinor))}.`,
    });
  if (pendingTxs.length)
    alerts.push({
      level: "info",
      code: "pending",
      text: `${pendingTxs.length} movimiento(s) en proceso aún no afectan el saldo.`,
    });
  if (income && cycleChargesMinor > income)
    alerts.push({
      level: "warning",
      code: "over-income",
      text: `Los cargos de los ciclos actuales (${fmt(cycleChargesMinor)}) superan el ingreso de referencia (${fmt(income)}) por ${fmt(cycleChargesMinor - income)}. Los ciclos no coinciden con un mes calendario.`,
    });
  if (inflowsMinor && marginMinor < 0)
    alerts.push({
      level: "danger",
      code: "shortfall",
      text: `Las entradas registradas no cubren lo por pagar y los compromisos: faltan ${fmt(-marginMinor)}.`,
    });
  if (payUnknown.length)
    alerts.push({
      level: "info",
      code: "pay-unknown",
      text: `Sin importe a pagar en: ${payUnknown.join(", ")}.`,
    });
  if (activeInstallments.some((i) => i.estimated))
    alerts.push({
      level: "info",
      code: "estimated",
      text: "Hay mensualidades con monto estimado.",
    });

  return {
    configured: true,
    today,
    reconciledAt: data.reconciledAt,
    expiresAt,
    expired,
    currency: "MXN",
    incomeMonthlyMinor: income,
    totals: {
      limitMinor: sum(cards, (c) => c.limitMinor),
      usedMinor: sum(cards, (c) => c.balanceMinor),
      availableMinor: sum(cards, (c) => c.availableMinor),
      usedPct: sum(cards, (c) => c.limitMinor)
        ? sum(cards, (c) => c.balanceMinor) / sum(cards, (c) => c.limitMinor)
        : 0,
      payMinor,
      cycleChargesMinor,
    },
    cards,
    flow: {
      inflows,
      inflowsMinor,
      payMinor,
      afterPayMinor: inflowsMinor - payMinor,
      installmentsMonthlyMinor,
      fixedMinor,
      commitmentsMinor: installmentsMonthlyMinor + fixedMinor,
      marginMinor,
    },
    commitments,
    installments,
    installmentsRemainingMinor: sum(
      activeInstallments,
      (i) => i.remainingMinor,
    ),
    categories,
    leak: {
      since,
      days: 30,
      rows: leakRows,
      totalMinor: leakMinor,
      perDayMinor: Math.round(leakMinor / 30),
    },
    transactions: txs,
    unidentifiedCount: unidentified.length,
    pendingCount: pendingTxs.length,
    upcoming,
    alerts,
    questions: data.questions,
  };
}

/* ---------- operations (the only way agents change finance data) ---------- */
/** @param {FinanceData} data @param {unknown} ref */
function findCard(data, ref, { optional = false } = {}) {
  const key = norm(ref);
  if (!key) {
    if (optional) return undefined;
    throw new Failure("Indica la tarjeta (--card).");
  }
  const exact = data.cards.filter(
    (c) =>
      c.id === key || norm(c.name) === key || String(c.last4 || "") === key,
  );
  const fuzzy = exact.length
    ? exact
    : data.cards.filter((c) => norm(c.name).includes(key));
  if (fuzzy.length === 1) return fuzzy[0];
  if (optional) return undefined;
  throw new Failure(
    `${fuzzy.length ? "Tarjeta ambigua" : "Tarjeta desconocida"}: "${ref}". Disponibles: ${data.cards.map((c) => c.name).join(", ") || "ninguna"}.`,
  );
}
/** @param {{ id: string }[]} rows @param {string} prefix */
const nextId = (rows, prefix, width = 3) => {
  const n = Math.max(
    0,
    ...rows.map((r) => Number(String(r.id || "").replace(prefix, "")) || 0),
  );
  return prefix + String(n + 1).padStart(width, "0");
};
/** @param {FinanceData} data @param {string} desc */
function guessCategory(data, desc) {
  const key = norm(desc);
  const prior = [...data.transactions]
    .reverse()
    .find(
      (t) =>
        t.type === "charge" &&
        norm(t.desc) === key &&
        t.category &&
        t.category !== UNIDENTIFIED,
    );
  return prior?.category;
}
/** @param {FinanceCard} card @param {FinanceTransaction} t */
function applyBalance(card, t) {
  card.balanceMinor = (card.balanceMinor || 0) + t.amountMinor;
  if (t.type === "payment" && Number.isFinite(card.payMinor))
    card.payMinor = Math.max(0, card.payMinor + t.amountMinor);
}
/** @param {FinanceData} data @param {FinanceOperation} op @param {FinanceTransactionType} type @param {string} today */
function addTx(data, op, type, today) {
  const card = findCard(data, op.card);
  const amount = amountOf(op, "amount", "importe");
  const status = op.status === "pending" ? "pending" : "posted";
  const date = dayOf(op.date, today);
  const desc = text(
    op.desc ??
      /** @type {Partial<Record<FinanceTransactionType, string>>} */ ({
        payment: "Pago a tarjeta",
        cashback: "Cashback",
      })[type],
    "la descripción",
  );
  if (op.ref) {
    const prior = data.transactions.find((t) => t.ref === String(op.ref));
    if (prior) return { tx: prior, duplicate: true };
  }
  const signed = type === "charge" ? amount : -amount;
  if (
    !op.allowDuplicate &&
    data.transactions.some(
      (t) =>
        t.card === card.id &&
        t.date === date &&
        t.type === type &&
        t.amountMinor === signed &&
        norm(t.desc) === norm(desc),
    )
  )
    throw new Failure(
      `Ya existe un movimiento igual (${desc}, ${date}). Usa allowDuplicate/--allow-duplicate si es real.`,
      409,
    );
  const category =
    op.category ||
    (type === "payment"
      ? "Pago"
      : type === "cashback"
        ? "Cashback"
        : guessCategory(data, desc) || UNIDENTIFIED);
  /** @type {FinanceTransaction} */
  const tx = {
    id: nextId(data.transactions, "t"),
    date,
    card: card.id,
    desc,
    category,
    amountMinor: signed,
    type,
    status,
  };
  if (op.note) tx.note = text(op.note, "la nota", 300);
  if (op.ref) tx.ref = String(op.ref);
  data.transactions.push(tx);
  if (status === "posted") applyBalance(card, tx);
  return { tx, balanceMinor: card.balanceMinor };
}
/**
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => boolean} match
 * @param {() => NoInfer<T>} make
 * @param {(row: T) => void} update
 */
function upsert(rows, match, make, update) {
  const found = rows.find(match);
  if (found) {
    update(found);
    return found;
  }
  const created = make();
  rows.push(created);
  return created;
}
/** @template T @param {T} target @param {Partial<T>} source */
const assign = (target, source) => {
  for (const [k, v] of /** @type {[keyof T, T[keyof T]][]} */ (
    Object.entries(source)
  ))
    if (v !== undefined) target[k] = v;
  return target;
};

/** @satisfies {Record<string, FinanceHandler>} */
const handlers = {
  init(data) {
    return { created: true, cards: data.cards.length };
  },
  charge: (data, op, today) => addTx(data, op, "charge", today),
  payment: (data, op, today) => addTx(data, op, "payment", today),
  refund: (data, op, today) => addTx(data, op, "reversal", today),
  cashback: (data, op, today) => addTx(data, op, "cashback", today),
  settle(data, op) {
    const tx = data.transactions.find((t) => t.id === op.id);
    if (!tx) throw new Failure(`No existe el movimiento ${op.id}.`);
    if (tx.status !== "pending") return { tx, unchanged: true };
    tx.status = "posted";
    const card = findCard(data, tx.card);
    applyBalance(card, tx);
    return { tx, balanceMinor: card.balanceMinor };
  },
  "tx-edit"(data, op) {
    const tx = data.transactions.find((t) => t.id === op.id);
    if (!tx) throw new Failure(`No existe el movimiento ${op.id}.`);
    if (op.category !== undefined)
      tx.category = text(op.category, "la categoría", 80);
    if (op.desc !== undefined) tx.desc = text(op.desc, "la descripción");
    if (op.note !== undefined) tx.note = String(op.note).slice(0, 300);
    if (op.date !== undefined) tx.date = dayOf(op.date);
    return { tx };
  },
  "tx-delete"(data, op) {
    const index = data.transactions.findIndex((t) => t.id === op.id);
    if (index < 0) throw new Failure(`No existe el movimiento ${op.id}.`);
    const [tx] = data.transactions.splice(index, 1);
    if (tx.status === "posted") {
      const card = findCard(data, tx.card, { optional: true });
      if (card) card.balanceMinor = (card.balanceMinor || 0) - tx.amountMinor;
    }
    return { removed: tx.id };
  },
  "card-set": (data, op, today) => cardSet(data, op, today, false),
  "card-add": (data, op, today) => cardSet(data, op, today, true),
  "installment-set"(data, op) {
    const label = text(op.label, "la compra");
    const card = findCard(data, op.card, { optional: true });
    const patch = {
      label,
      card: card?.id,
      originalMinor: has(op, "original")
        ? minorOf(op, "original", "total")
        : undefined,
      months: op.months !== undefined ? Number(op.months) : undefined,
      monthlyMinor: has(op, "monthly")
        ? minorOf(op, "monthly", "pago mensual")
        : undefined,
      paid: op.paid !== undefined ? Number(op.paid) : undefined,
      remainingMinor: has(op, "remaining")
        ? minorOf(op, "remaining", "saldo")
        : undefined,
      estimated:
        op.estimated === undefined
          ? undefined
          : op.estimated === true || op.estimated === "true",
    };
    for (const k of /** @type {const} */ (["months", "paid"]))
      if (
        patch[k] !== undefined &&
        (!Number.isInteger(patch[k]) || patch[k] < 0)
      )
        throw new Failure(`${k} debe ser un entero positivo.`);
    const row = upsert(
      data.installments,
      (i) => norm(i.label) === norm(label),
      () => {
        if (patch.months === undefined || patch.monthlyMinor === undefined)
          throw new Failure(
            "Una mensualidad nueva necesita --months y --monthly.",
          );
        return { id: nextId(data.installments, "m", 2), paid: 0 };
      },
      () => {},
    );
    assign(row, patch);
    return { installment: installmentView(row) };
  },
  "installment-pay"(data, op) {
    const key = norm(op.label ?? op.id);
    const row = data.installments.find(
      (i) => i.id === op.id || norm(i.label) === key,
    );
    if (!row)
      throw new Failure(`No existe la mensualidad "${op.label ?? op.id}".`);
    const count = Number(op.count ?? 1);
    if (!Number.isInteger(count) || count < 1)
      throw new Failure("count debe ser un entero positivo.");
    row.paid = Math.min(
      Number(row.months) || 0,
      (Number(row.paid) || 0) + count,
    );
    delete row.remainingMinor;
    return { installment: installmentView(row) };
  },
  "installment-remove"(data, op) {
    const key = norm(op.label ?? op.id);
    const index = data.installments.findIndex(
      (i) => i.id === op.id || norm(i.label) === key,
    );
    if (index < 0) throw new Failure("No existe esa mensualidad.");
    data.installments.splice(index, 1);
    return { removed: true };
  },
  "commitment-set"(data, op) {
    const label = text(op.label, "el compromiso");
    const card = findCard(data, op.card, { optional: true });
    const patch = {
      label,
      amountMinor: has(op, "amount")
        ? amountOf(op, "amount", "importe")
        : undefined,
      card: card?.id,
      dayOfMonth:
        op.dayOfMonth !== undefined ? Number(op.dayOfMonth) : undefined,
      note: op.note,
    };
    if (
      patch.dayOfMonth !== undefined &&
      !(patch.dayOfMonth >= 1 && patch.dayOfMonth <= 31)
    )
      throw new Failure("dayOfMonth debe estar entre 1 y 31.");
    const row = upsert(
      data.commitments,
      (c) => norm(c.label) === norm(label),
      () => {
        if (patch.amountMinor === undefined)
          throw new Failure("Un compromiso nuevo necesita --amount.");
        return { id: nextId(data.commitments, "c", 2) };
      },
      () => {},
    );
    return { commitment: assign(row, patch) };
  },
  "commitment-remove"(data, op) {
    const key = norm(op.label ?? op.id);
    const index = data.commitments.findIndex(
      (c) => c.id === op.id || norm(c.label) === key,
    );
    if (index < 0) throw new Failure("No existe ese compromiso.");
    data.commitments.splice(index, 1);
    return { removed: true };
  },
  "cash-set"(data, op) {
    const label = text(op.label, "la entrada");
    const kinds = ["savings", "income", "other"];
    if (op.kind !== undefined && !kinds.includes(op.kind))
      throw new Failure(`kind debe ser ${kinds.join(", ")}.`);
    const patch = {
      label,
      kind: op.kind,
      amountMinor: has(op, "amount")
        ? amountOf(op, "amount", "importe")
        : undefined,
      recurring:
        op.recurring === undefined
          ? undefined
          : op.recurring === true || op.recurring === "true",
      available: op.available === undefined ? undefined : dayOf(op.available),
      note: op.note,
    };
    const row = upsert(
      data.cash,
      (c) => norm(c.label) === norm(label),
      () => {
        if (patch.amountMinor === undefined)
          throw new Failure("Una entrada nueva necesita --amount.");
        return {
          id: nextId(data.cash, "e", 2),
          kind: "income",
          recurring: false,
        };
      },
      () => {},
    );
    return { cash: assign(row, patch) };
  },
  "cash-remove"(data, op) {
    const key = norm(op.label ?? op.id);
    const index = data.cash.findIndex(
      (c) => c.id === op.id || norm(c.label) === key,
    );
    if (index < 0) throw new Failure("No existe esa entrada.");
    data.cash.splice(index, 1);
    return { removed: true };
  },
  "income-set"(data, op) {
    data.incomeMonthlyMinor = amountOf(op, "monthly", "ingreso mensual");
    return { incomeMonthlyMinor: data.incomeMonthlyMinor };
  },
  "question-add"(data, op, today) {
    const q = {
      id: nextId(data.questions, "q", 2),
      text: text(op.text, "la pregunta", 300),
      since: today,
    };
    data.questions.push(q);
    return { question: q };
  },
  "question-resolve"(data, op) {
    const index = data.questions.findIndex((q) => q.id === op.id);
    if (index < 0) throw new Failure(`No existe la pregunta ${op.id}.`);
    data.questions.splice(index, 1);
    return { removed: op.id };
  },
  settings(data, op) {
    if (op.leakCategories !== undefined) {
      /** @type {unknown[]} */
      const list = Array.isArray(op.leakCategories)
        ? op.leakCategories
        : String(op.leakCategories).split(",");
      data.leakCategories = list.map((s) => String(s).trim()).filter(Boolean);
    }
    for (const k of /** @type {const} */ (["validityDays", "staleAfterDays"]))
      if (op[k] !== undefined) {
        const n = Number(op[k]);
        if (!Number.isInteger(n) || n < 1 || n > 90)
          throw new Failure(`${k} debe estar entre 1 y 90.`);
        data[k] = n;
      }
    return { ok: true };
  },
  reconcile(data, _op, today) {
    data.reconciledAt = today;
    return { reconciledAt: today };
  },
};
/** @param {FinanceData} data @param {FinanceOperation} op @param {string} today @param {boolean} create */
function cardSet(data, op, today, create) {
  let card = create ? undefined : findCard(data, op.card ?? op.name);
  if (create) {
    const name = text(op.name, "el nombre de la tarjeta", 60);
    if (findCard(data, name, { optional: true }))
      throw new Failure(`La tarjeta ${name} ya existe.`, 409);
    card = { id: slug(name), name };
    if (!has(op, "limit"))
      throw new Failure("Una tarjeta nueva necesita --limit.");
    data.cards.push(card);
  }
  /** @type {Partial<FinanceCard>} */
  const patch = {
    name:
      create || op.rename === undefined
        ? undefined
        : text(op.rename, "el nombre", 60),
    last4: op.last4 === undefined ? undefined : String(op.last4),
    limitMinor: has(op, "limit") ? amountOf(op, "limit", "límite") : undefined,
    balanceMinor: has(op, "balance")
      ? minorOf(op, "balance", "saldo")
      : undefined,
    payMinor: has(op, "pay") ? minorOf(op, "pay", "pago") : undefined,
    payNote: op.payNote,
    cutDate:
      op.cutDate === undefined
        ? undefined
        : dayOf(op.cutDate, undefined, "fecha de corte"),
    cycleStart:
      op.cycleStart === undefined
        ? undefined
        : dayOf(op.cycleStart, undefined, "inicio de ciclo"),
    cutNote: op.cutNote,
    dueDate:
      op.dueDate === undefined
        ? undefined
        : dayOf(op.dueDate, undefined, "fecha límite"),
    dueEstimated:
      op.dueEstimated === undefined
        ? undefined
        : op.dueEstimated === true || op.dueEstimated === "true",
    note: op.note,
  };
  if (patch.balanceMinor !== undefined || patch.payMinor !== undefined)
    patch.asOf =
      op.asOf === undefined
        ? today
        : dayOf(op.asOf, undefined, "fecha del saldo");
  else if (op.asOf !== undefined) patch.asOf = dayOf(op.asOf);
  assign(card, patch);
  return { card: { id: card.id, name: card.name } };
}

export const OPERATIONS = Object.keys(handlers);

/** @param {unknown} rawData @param {FinanceOperation} op @param {string} today */
export function applyOperation(rawData, op, today) {
  const handler = handlers[/** @type {keyof typeof handlers} */ (op?.op)];
  if (!handler)
    throw new Failure(
      `Operación desconocida: ${op?.op}. Disponibles: ${OPERATIONS.join(", ")}.`,
    );
  const data = structuredClone(normalize(rawData));
  const result = handler(data, op, today);
  return { data, result };
}
