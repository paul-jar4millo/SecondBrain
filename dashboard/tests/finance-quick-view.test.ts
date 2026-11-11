import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FinanceQuickView } from "../src/components/FinanceQuickView";
import { money } from "../src/core/model";
import type { FinanceOverview } from "../src/features/finance/useFinance";

const data: FinanceOverview = {
  configured: true,
  totals: {
    limitMinor: 100000,
    usedMinor: 20000,
    availableMinor: 80000,
    usedPct: 0.2,
    payMinor: 30000,
    cycleChargesMinor: 15000,
  },
  flow: {
    inflows: [],
    inflowsMinor: 60000,
    payMinor: 30000,
    afterPayMinor: 30000,
    installmentsMonthlyMinor: 5000,
    fixedMinor: 10000,
    commitmentsMinor: 15000,
    marginMinor: 15000,
  },
  upcoming: [
    { date: "2026-11-08", type: "cut", label: "Corte", estimated: false },
    {
      date: "2026-11-10",
      type: "due",
      label: "Tarjeta de ejemplo",
      amountMinor: 30000,
      estimated: true,
    },
  ],
};

describe("financial quick view", () => {
  it("distinguishes projected money, debt and the next actual payment date", () => {
    const html = renderToStaticMarkup(
      createElement(FinanceQuickView, { data, hidden: false, show: money }),
    );
    expect(html).toContain("$600.00");
    expect(html).toContain("$300.00");
    expect(html).toContain("$150.00");
    expect(html).toContain("Tarjeta de ejemplo");
    expect(html).toContain("fecha estimada");
    expect(html).toContain("Proyección, no saldo bancario");
    expect(html).not.toContain("NaN");
  });
  it("removes the graph and numeric accessibility labels when amounts are hidden", () => {
    const html = renderToStaticMarkup(
      createElement(FinanceQuickView, {
        data,
        hidden: true,
        show: () => "••••••",
      }),
    );
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("$600.00");
    expect(html).not.toContain("20%");
    expect(html).not.toContain("<progress");
  });
  it("calls a negative margin a shortfall and handles no payment dates", () => {
    const html = renderToStaticMarkup(
      createElement(FinanceQuickView, {
        data: {
          ...data,
          flow: { ...data.flow!, marginMinor: -5000 },
          upcoming: [],
        },
        hidden: false,
        show: money,
      }),
    );
    expect(html).toContain("Faltaría cubrir");
    expect(html).toContain("$50.00");
    expect(html).toContain("No hay una fecha de pago registrada");
  });
});
