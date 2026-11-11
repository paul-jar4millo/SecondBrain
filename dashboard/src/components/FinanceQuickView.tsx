import { CalendarClock, WalletCards } from "lucide-react";
import { dateLabel } from "../core/model";
import { chartPercent } from "../core/overview";
import { WaterBar } from "./QuickView";
import type { FinanceOverview } from "../features/finance/useFinance";

export function FinanceQuickView({
  data,
  hidden,
  show,
}: {
  data: FinanceOverview;
  hidden: boolean;
  show: (n?: number) => string;
}) {
  const flow = data.flow!;
  const totals = data.totals!;
  const next = data.upcoming
    ?.filter((x) => x.type === "due")
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const scale = Math.max(
    flow.inflowsMinor,
    flow.payMinor,
    flow.commitmentsMinor,
    Math.abs(flow.marginMinor),
    1,
  );
  const rows = [
    {
      label: "Dinero registrado",
      amount: flow.inflowsMinor,
      tone: "income",
      hint: "Ahorro y entradas previstas",
    },
    {
      label: "Pagos de tarjetas",
      amount: flow.payMinor,
      tone: "payments",
      hint: "Lo que tienes por pagar",
    },
    {
      label: "Otros compromisos",
      amount: flow.commitmentsMinor,
      tone: "commitments",
      hint: "Mensualidades futuras y cargos fijos",
    },
    {
      label: flow.marginMinor < 0 ? "Faltaría cubrir" : "Quedaría disponible",
      amount: Math.abs(flow.marginMinor),
      tone: flow.marginMinor < 0 ? "negative" : "remaining",
      hint: "Después de pagos y compromisos",
    },
  ];
  return (
    <section
      className="finance-quick-view"
      aria-label="Tus finanzas de un vistazo"
    >
      <div className="money-story">
        <h2>¿Cómo queda tu dinero?</h2>
        <p>Dinero registrado menos pagos y compromisos.</p>
        {hidden ? (
          <p className="private-chart">Importes y gráficas ocultos.</p>
        ) : (
          <div
            className="money-bars"
            role="img"
            aria-label={rows
              .map((r) => `${r.label}: ${show(r.amount)}`)
              .join(". ")}
          >
            {rows.map((r) => (
              <div className={"money-bar-row " + r.tone} key={r.label}>
                <div>
                  <span>{r.label}</span>
                  <strong>{show(r.amount)}</strong>
                </div>
                <div className="money-bar-track">
                  <i style={{ width: chartPercent(r.amount, scale) + "%" }} />
                </div>
                <small>{r.hint}</small>
              </div>
            ))}
          </div>
        )}
        <p className="chart-footnote">
          {data.expired
            ? "Datos vencidos: actualiza antes de usar este cálculo. "
            : "Proyección, no saldo bancario. "}
          Depende de recibir las entradas a tiempo. No incluye comida,
          transporte ni gastos nuevos.
        </p>
      </div>
      <div className="finance-at-a-glance">
        <div className="next-payment">
          <CalendarClock size={23} aria-hidden="true" />
          <h2>Próximo pago</h2>
          {next ? (
            <>
              <strong className="next-payment-amount">
                {show(next.amountMinor)}
              </strong>
              <p>{next.label}</p>
              <span>
                {dateLabel(next.date, { day: "numeric", month: "long" })}
                {next.estimated ? " · fecha estimada" : ""}
                {next.overdue ? " · vencido" : ""}
              </span>
            </>
          ) : (
            <p>No hay una fecha de pago registrada. Revisa tus tarjetas.</p>
          )}
        </div>
        <div className="credit-explainer">
          <WalletCards size={22} aria-hidden="true" />
          <h2>Uso de tus tarjetas</h2>
          <div className="credit-amount">
            <strong>{show(totals.usedMinor)}</strong>
            <span>usados de {show(totals.limitMinor)}</span>
          </div>
          {!hidden && (
            <>
              <WaterBar
                value={Math.max(0, totals.usedMinor)}
                max={Math.max(totals.limitMinor, totals.usedMinor, 1)}
                label="Crédito utilizado"
              />
              <p>
                {Math.round(totals.usedPct * 100)}% del límite usado ·{" "}
                {show(totals.availableMinor)} de crédito disponible.
              </p>
            </>
          )}
          <small>
            Crédito disponible es dinero prestado, no ahorro. Deuda total y pago
            del periodo son distintos.
          </small>
        </div>
      </div>
    </section>
  );
}
