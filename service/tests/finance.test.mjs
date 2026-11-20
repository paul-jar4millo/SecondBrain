import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../vault.mjs";
import { createApplication } from "../index.mjs";
import {
  Finance,
  FINANCE_PATH,
  overview,
  toMinor,
  applyOperation,
} from "../finance.mjs";
import { parseLedgerExport } from "../finance-import.mjs";

const TODAY = "2026-11-06";
// Synthetic data only: never the real vault.
const REGISTRY = `# Registro

### Resumen (exportado 2026-11-05)

### Indicadores
| Indicador | Valor |
|---|---|
| cargos_netos_ciclo_actual | 600.00 |
| ingreso_mensual_referencia | 2000 |
| por_pagar_tarjetas | 500.00 |
| credito_usado | 900.00 |
| margen_tras_compromisos | 290.00 |

### Tarjetas
| Tarjeta | Últimos 4 | Límite | Corte (día) | Saldo | A pagar | Fecha límite | Ciclo | Nota |
|---|---|---|---|---|---|---|---|---|
| Alfa | 1111 | $10,000.00 | 4 | $700.00 | $300.00 | 2026-11-24 | 5 oct - 4 nov | Estimada |
| Beta | 2222 | $5,000.00 | 11 | $200.00 | $200.00 | 2026-12-01 | 12 oct - 10 nov | Estimada |

### Flujo de efectivo
| Grupo | Concepto | Monto |
|---|---|---|
| Entradas | Ahorros | $1,000.00 |
| Referencia | Ingreso mensual | $2,000.00 |
| Comprometido | Streaming | $100.00 |
| Comprometido | Compra a meses (1 mensualidad) | $110.00 |

### Mensualidades (Compra a meses, Alfa)
| Compra | Original | Meses | Pago mensual | Pagos hechos | Saldo pendiente | Monto estimado |
|---|---|---|---|---|---|---|
| Consola | $330.00 | 3 | $110.00 | 1 | $220.00 | False |

### Movimientos (4)
| ID | Fecha | Tarjeta | Descripción | Categoría | Monto | Tipo | Estado | Ciclo | Nota |
|---|---|---|---|---|---|---|---|---|---|
| t001 | 2026-11-03 | Alfa | Streaming | Servicios | $100.00 | cargo | aplicado | actual |  |
| t002 | 2026-11-02 | Alfa | Tacos | Comida fuera | $300.00 | cargo | aplicado | actual |  |
| t003 | 2026-11-01 | Beta | Pago a tarjeta | Pago | $-50.00 | pago | aplicado | actual |  |
| t004 | 2026-10-20 | Beta | Cine | Entretenimiento | $200.00 | cargo | en proceso | actual |  |
`;

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-fin-"));
  for (const dir of ["00-Inbox", "02-Areas/Finanzas", "99-Meta"])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Mi vault\n");
  const vault = new Vault(root);
  try {
    await fn({ root, vault, finance: new Finance(vault) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const seeded = async (finance) => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  await finance.create(data, TODAY);
};

test("toMinor parses pesos without float drift and rejects bad input", () => {
  assert.equal(toMinor("1,234.50"), 123450);
  assert.equal(toMinor(0.29), 29);
  assert.equal(toMinor("$-600.00"), -60000);
  assert.throws(() => toMinor("12.345"));
  assert.throws(() => toMinor("abc"));
});

test("the importer reproduces the indicators declared by the export", () => {
  const { data, expected } = parseLedgerExport(REGISTRY, TODAY);
  const view = overview(data, TODAY);
  assert.equal(view.totals.cycleChargesMinor, expected.cycleChargesMinor);
  assert.equal(view.totals.usedMinor, expected.usedMinor);
  assert.equal(view.totals.payMinor, expected.payMinor);
  assert.equal(view.flow.marginMinor, expected.marginMinor);
  assert.equal(
    data.commitments.length,
    1,
    "installments are not fixed commitments",
  );
  assert.equal(data.commitments[0].card, "alfa");
});

test("payments and cashback are never spending; pending rows still count in the cycle", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  const view = overview(data, TODAY);
  const beta = view.cards.find((c) => c.id === "beta");
  assert.equal(beta.cycleChargesMinor, 20000);
  assert.ok(view.categories.every((c) => c.category !== "Pago"));
  assert.equal(view.pendingCount, 1);
});

test("alerts state the arithmetic: expired data, over-income, due soon, cut passed", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  const late = overview(data, "2026-11-22");
  const codes = late.alerts.map((a) => a.code);
  assert.ok(codes.includes("expired"));
  assert.ok(codes.includes("cut-passed"));
  assert.ok(codes.includes("due-soon"));
  const over = overview({ ...data, incomeMonthlyMinor: 10000 }, TODAY);
  assert.ok(
    over.alerts.some((a) => a.code === "over-income" && /superan/.test(a.text)),
  );
});

test("charge learns categories, rejects duplicates, is idempotent by ref and moves the balance", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  const first = applyOperation(
    data,
    { op: "charge", card: "alfa", amount: "300", desc: "Tacos", date: TODAY },
    TODAY,
  );
  assert.equal(first.result.tx.category, "Comida fuera");
  assert.equal(first.result.balanceMinor, 70000 + 30000);
  assert.throws(
    () =>
      applyOperation(
        first.data,
        { op: "charge", card: "alfa", amount: 300, desc: "Tacos", date: TODAY },
        TODAY,
      ),
    /Ya existe/,
  );
  const unknown = applyOperation(
    data,
    { op: "charge", card: "Alfa", amount: 12.5, desc: "Lasul", ref: "r1" },
    TODAY,
  );
  assert.equal(unknown.result.tx.category, "Sin identificar");
  const again = applyOperation(
    unknown.data,
    { op: "charge", card: "alfa", amount: 12.5, desc: "Lasul", ref: "r1" },
    TODAY,
  );
  assert.equal(again.result.duplicate, true);
  assert.equal(
    again.data.transactions.length,
    unknown.data.transactions.length,
  );
});

test("payments reduce the balance and amount due; pending ones wait for settle", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  const paid = applyOperation(
    data,
    { op: "payment", card: "alfa", amount: 100 },
    TODAY,
  );
  const alfa = paid.data.cards.find((c) => c.id === "alfa");
  assert.equal(alfa.balanceMinor, 60000);
  assert.equal(alfa.payMinor, 20000);
  const pending = applyOperation(
    data,
    { op: "payment", card: "alfa", amount: 100, status: "pending" },
    TODAY,
  );
  assert.equal(pending.data.cards[0].balanceMinor, 70000);
  const id = pending.result.tx.id;
  const settled = applyOperation(pending.data, { op: "settle", id }, TODAY);
  assert.equal(settled.data.cards[0].balanceMinor, 60000);
  const removed = applyOperation(settled.data, { op: "tx-delete", id }, TODAY);
  assert.equal(removed.data.cards[0].balanceMinor, 70000);
});

test("unknown cards and invalid input fail with actionable messages", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  assert.throws(
    () =>
      applyOperation(
        data,
        { op: "charge", card: "zeta", amount: 1, desc: "x" },
        TODAY,
      ),
    /Disponibles: Alfa, Beta/,
  );
  assert.throws(
    () =>
      applyOperation(
        data,
        { op: "charge", card: "alfa", amount: -5, desc: "x" },
        TODAY,
      ),
    /mayor que cero/,
  );
  assert.throws(() =>
    applyOperation(
      data,
      { op: "charge", card: "alfa", amount: 5, desc: "x", date: "2026-02-31" },
      TODAY,
    ),
  );
  assert.throws(
    () => applyOperation(data, { op: "nada" }, TODAY),
    /Operación desconocida/,
  );
});

test("installments, commitments and cash flow feed the margin", () => {
  const { data } = parseLedgerExport(REGISTRY, TODAY);
  let state = applyOperation(
    data,
    { op: "installment-pay", label: "Consola", count: 2 },
    TODAY,
  ).data;
  assert.equal(
    overview(state, TODAY).flow.installmentsMonthlyMinor,
    0,
    "finished installments leave the monthly total",
  );
  state = applyOperation(
    state,
    { op: "commitment-set", label: "Streaming", amount: 120 },
    TODAY,
  ).data;
  assert.equal(state.commitments[0].amountMinor, 12000);
  state = applyOperation(
    state,
    { op: "cash-set", label: "Beca", amount: 500, kind: "income" },
    TODAY,
  ).data;
  assert.equal(overview(state, TODAY).flow.inflowsMinor, 150000);
});

test("persists in one Markdown file, keeps the body and unknown frontmatter, and refuses to overwrite", () =>
  fixture(async ({ root, finance }) => {
    await seeded(finance);
    await assert.rejects(seeded(finance), /no se sobrescriben/);
    const file = path.join(root, FINANCE_PATH);
    let text = await readFile(file, "utf8");
    assert.match(text, /^---\ntype: finanzas/);
    assert.match(text, /verified: 2026-11-05/);
    assert.match(text, /expires: 2026-11-12/);
    text = text.replace(
      "status: active",
      "status: active\ncustom: keep-me # comentario",
    );
    text = text.replace(
      "# Datos financieros",
      "# Datos financieros\n\nNota escrita a mano.",
    );
    await writeFile(file, text);
    await finance.run(
      {
        op: "charge",
        card: "alfa",
        amount: 50,
        desc: "Café",
        category: "Cafeterías",
        date: TODAY,
      },
      TODAY,
    );
    const after = await readFile(file, "utf8");
    assert.match(after, /custom: keep-me # comentario/);
    assert.match(after, /Nota escrita a mano\./);
    assert.match(after, /desc: Café/);
    const view = await finance.overview(TODAY);
    assert.equal(view.transactions.length, 5);
    assert.equal(view.cards[0].balanceMinor, 75000);
  }));

test("concurrent agent writes are serialized and none is lost", () =>
  fixture(async ({ finance }) => {
    await seeded(finance);
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        finance.run(
          {
            op: "charge",
            card: "alfa",
            amount: n,
            desc: "Compra " + n,
            date: TODAY,
          },
          TODAY,
        ),
      ),
    );
    const view = await finance.overview(TODAY);
    assert.equal(view.transactions.length, 10);
    assert.equal(view.cards[0].balanceMinor, 70000 + 2100);
    assert.equal(new Set(view.transactions.map((t) => t.id)).size, 10);
  }));

test("HTTP: overview and ops go through CSRF and update the same file", () =>
  fixture(async ({ root, finance }) => {
    await seeded(finance);
    const runtime = await mkdtemp(path.join(tmpdir(), "sb-fin-run-"));
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: runtime,
      auth: false,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + app.server.address().port;
    try {
      const jar = {};
      const csrf = await fetch(base + "/api/v1/auth/csrf");
      const cookie = csrf.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const { token } = await csrf.json();
      const post = (body, extra = {}) =>
        fetch(base + "/api/v1/finance/ops", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "X-CSRF-TOKEN": token,
            ...extra,
          },
          body: JSON.stringify(body),
        });
      const missingToken = await fetch(base + "/api/v1/finance/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      });
      assert.equal(missingToken.status, 400);
      const ok = await post({
        op: "charge",
        card: "beta",
        amount: 80,
        desc: "Tacos",
        date: TODAY,
      });
      assert.equal(ok.status, 200);
      const bad = await post({
        op: "charge",
        card: "nadie",
        amount: 80,
        desc: "x",
      });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /Tarjeta desconocida/);
      const view = await (
        await fetch(base + "/api/v1/finance/overview")
      ).json();
      assert.equal(view.configured, true);
      assert.equal(
        view.cards.find((c) => c.id === "beta").balanceMinor,
        20000 + 8000,
      );
      void jar;
    } finally {
      await app.close();
      await rm(runtime, { recursive: true, force: true });
    }
  }));

test("without data the overview reports not configured instead of failing", () =>
  fixture(async ({ finance }) => {
    assert.deepEqual(await finance.overview(TODAY), { configured: false });
    await assert.rejects(
      finance.run({ op: "charge", card: "x", amount: 1, desc: "x" }, TODAY),
      /init/,
    );
    await finance.run({ op: "init" }, TODAY);
    await finance.run(
      { op: "card-add", name: "Oro", limit: 8000, last4: "9999" },
      TODAY,
    );
    assert.equal((await finance.overview(TODAY)).cards[0].limitMinor, 800000);
  }));

test("an operation retried with the same requestId is applied only once", () =>
  fixture(async ({ finance }) => {
    await seeded(finance);
    const pay = {
      op: "installment-pay",
      label: "Consola",
      requestId: "agente-1",
    };
    const first = await finance.run(pay, TODAY);
    const again = await finance.run({ ...pay }, TODAY);
    assert.deepEqual(again, first);
    const view = await finance.overview(TODAY);
    assert.equal(view.installments.find((i) => i.label === "Consola").paid, 2);
  }));
