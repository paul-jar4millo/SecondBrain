import { ApprovalPanel } from "./ApprovalPanel";
import { useMemo, useState } from "react";
import {
  Plus,
  Eye,
  EyeOff,
  ArrowUpRight,
  ArrowDownLeft,
  RefreshCw,
  ImagePlus,
} from "lucide-react";
import { active, dateLabel, money } from "../../core/model";
import { isDemo } from "../../core/store";
import { useUI, Empty, SectionTitle } from "../../components/ui";
import { PageHeading } from "../../components/PageHeading";
import { FinanceQuickView } from "../../components/FinanceQuickView";
import { LegacyLedger } from "./LegacyLedger";
import { CardDialog, TxDialog, TxEditDialog } from "./FinanceForms";
import { UpdateWithAgent } from "./UpdateWithAgent";
import { useFinance, type FinCard, type FinTx } from "./useFinance";

const pct = (n: number, digits = 0) => (n * 100).toFixed(digits) + "%";
const CREDIT: FinTx["type"][] = ["payment", "cashback", "reversal"];
const monthLabel = (month: string) =>
  new Date(month + "-15T12:00:00Z").toLocaleDateString("es-MX", {
    month: "long",
    year: "numeric",
  });

type Dialog =
  | { kind: "tx" }
  | { kind: "agent" }
  | { kind: "card"; card?: string }
  | { kind: "edit"; tx: FinTx }
  | null;

export function FinancePage() {
  const { items, edit } = useUI();
  const { data, error, run } = useFinance();
  const [hidden, setHidden] = useState(
    localStorage.getItem("sb-hide-money") === "true",
  );
  const [cardFilter, setCardFilter] = useState("");
  const [month, setMonth] = useState("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  const show = (n?: number) =>
    hidden ? "••••••" : n === undefined ? "Por confirmar" : money(n);
  const legacy = active(items, "account").length > 0 && !isDemo;

  const months = useMemo(
    () => [
      ...new Set((data?.transactions || []).map((t) => t.date.slice(0, 7))),
    ],
    [data],
  );
  const activeMonth =
    month === "all" ? "" : months.includes(month) ? month : months[0] || "";
  const rows = useMemo(
    () =>
      (data?.transactions || []).filter(
        (t) =>
          (!activeMonth || t.date.startsWith(activeMonth)) &&
          (!cardFilter || t.card === cardFilter) &&
          (!query ||
            (t.desc + " " + (t.category || ""))
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [data, activeMonth, cardFilter, query],
  );

  if (isDemo) return <LegacyLedger />;

  const heading = (
    <PageHeading
      title="Finanzas"
      description={
        data?.configured
          ? `Verificado el ${dateLabel(data.reconciledAt)}${data.expired ? " · caducado" : " · vigente hasta el " + dateLabel(data.expiresAt)}`
          : undefined
      }
      action={
        <div className="heading-actions">
          <button
            className="icon-button"
            aria-label={hidden ? "Mostrar importes" : "Ocultar importes"}
            title={hidden ? "Mostrar importes" : "Ocultar importes"}
            onClick={() => {
              setHidden(!hidden);
              localStorage.setItem("sb-hide-money", String(!hidden));
              window.dispatchEvent(new Event("sb-money-visibility"));
            }}
          >
            {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
          {data?.configured && (
            <>
              <button
                className="button"
                onClick={() => setDialog({ kind: "card" })}
              >
                <RefreshCw size={16} />
                Actualizar tarjeta
              </button>
              <button
                className="button"
                onClick={() => setDialog({ kind: "tx" })}
              >
                <Plus size={16} />
                Movimiento
              </button>
              <button
                className="button primary"
                onClick={() => setDialog({ kind: "agent" })}
              >
                <ImagePlus size={16} />
                Actualizar con agente
              </button>
            </>
          )}
        </div>
      }
    />
  );

  if (!data)
    return (
      <>
        {heading}
        <ApprovalPanel hideEmpty />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Empty heading="Cargando finanzas…" />
        )}
      </>
    );
  if (!data.configured)
    return (
      <>
        {heading}
        <ApprovalPanel hideEmpty />
        <Empty heading="Aún no hay datos financieros." />
        <p className="page-guide">
          Tus tarjetas aparecerán aquí cuando se registre su información. Puedes
          empezar con una cuenta manual para llevar tus movimientos.
        </p>
        <button className="button primary" onClick={() => edit("account")}>
          Añadir cuenta manual
        </button>
        {legacy && <LegacyLedger />}
      </>
    );

  const flow = data.flow!;
  const cards = data.cards || [];
  const categories = [
    ...new Set(
      (data.transactions || []).map((t) => t.category).filter(Boolean),
    ),
  ] as string[];
  const alerts = data.alerts || [];
  const shownAlerts = showAllAlerts ? alerts : alerts.slice(0, 4);
  const maxCategory = Math.max(
    1,
    ...(data.categories || []).map((c) => c.amountMinor),
  );
  const closeDialog = () => setDialog(null);

  return (
    <>
      {heading}
      <ApprovalPanel hideEmpty />
      <nav className="finance-jumps" aria-label="Vistas rápidas de finanzas">
        <a href="#financial-cards">Tarjetas y pagos</a>
        <a href="#financial-categories">Gráfica de gastos</a>
        <a href="#financial-movements">Movimientos</a>
      </nav>
      {alerts.length > 0 && (
        <details
          className="finance-alert-drawer"
          open={
            data.expired ||
            alerts.some((a) => a.level === "danger" || a.code === "overdue")
          }
        >
          <summary>
            {alerts.length}{" "}
            {alerts.length === 1 ? "aviso por revisar" : "avisos por revisar"} ·
            ver detalles
          </summary>
          <ul className="fin-alerts" aria-label="Avisos financieros">
            {shownAlerts.map((a, i) => (
              <li key={a.code + i} className={"fin-alert " + a.level}>
                {hidden
                  ? "Aviso financiero pendiente. Muestra los importes para ver el detalle."
                  : a.text}
              </li>
            ))}
            {alerts.length > 4 && (
              <li>
                <button
                  className="text-link"
                  onClick={() => setShowAllAlerts(!showAllAlerts)}
                >
                  {showAllAlerts ? "Ver menos" : `Ver ${alerts.length - 4} más`}
                </button>
              </li>
            )}
          </ul>
        </details>
      )}

      <FinanceQuickView data={data} hidden={hidden} show={show} />
      <div className="finance-section-intro">
        <h2>Tus tarjetas</h2>
        <p>
          El importe destacado es el pago del periodo. Selecciona una tarjeta
          para filtrar sus movimientos.
        </p>
      </div>
      <section id="financial-cards" className="fin-cards" aria-label="Tarjetas">
        {cards.map((c) => (
          <CardTile
            key={c.id}
            card={c}
            show={show}
            hidden={hidden}
            selected={cardFilter === c.id}
            onSelect={() => setCardFilter(cardFilter === c.id ? "" : c.id)}
            onEdit={() => setDialog({ kind: "card", card: c.id })}
          />
        ))}
      </section>

      <div className="finance-layout fin-layout">
        <div>
          <details className="finance-calculation">
            <summary>Ver cómo se calcula lo que queda</summary>
            <section>
              <SectionTitle title="Detalle del cálculo" />
              <table className="fin-table">
                <tbody>
                  {flow.inflows.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {e.label}
                        <small>
                          {e.kind === "savings"
                            ? "Ahorro existente, no ingreso nuevo"
                            : e.recurring
                              ? "Recurrente"
                              : "No recurrente"}
                          {e.available
                            ? " · disponible " + dateLabel(e.available)
                            : ""}
                        </small>
                      </td>
                      <td>{show(e.amountMinor)}</td>
                    </tr>
                  ))}
                  <tr className="sum">
                    <td>Entradas</td>
                    <td>{show(flow.inflowsMinor)}</td>
                  </tr>
                  <tr>
                    <td>Por pagar a tarjetas</td>
                    <td>−{show(flow.payMinor)}</td>
                  </tr>
                  <tr className="sum">
                    <td>Queda tras pagar</td>
                    <td>{show(flow.afterPayMinor)}</td>
                  </tr>
                  <tr>
                    <td>
                      Mensualidades del siguiente ciclo
                      <small>Compras a meses sin intereses</small>
                    </td>
                    <td>−{show(flow.installmentsMonthlyMinor)}</td>
                  </tr>
                  <tr>
                    <td>
                      Cargos fijos
                      <small>Suscripciones y servicios registrados</small>
                    </td>
                    <td>−{show(flow.fixedMinor)}</td>
                  </tr>
                  <tr
                    className={
                      "sum total" + (flow.marginMinor < 0 ? " negative" : "")
                    }
                  >
                    <td>Margen</td>
                    <td>{show(flow.marginMinor)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="fin-note">
                Escenario condicionado a que las entradas estén disponibles a
                tiempo; no incluye comida, gasolina ni gastos nuevos.
              </p>
            </section>
          </details>

          <section id="financial-categories">
            <SectionTitle title="¿En qué gastaste?" />
            <p className="page-guide">
              Cargos de los ciclos actuales, agrupados por categoría. No
              equivalen a un mes calendario.
            </p>
            {data.categories?.length ? (
              <ul className="fin-categories">
                {data.categories.map((c) => (
                  <li key={c.category}>
                    <span>{c.category}</span>
                    <div className="fin-bar">
                      <i
                        style={{
                          width: hidden
                            ? "0%"
                            : pct(c.amountMinor / maxCategory),
                        }}
                      />
                    </div>
                    <strong>{show(c.amountMinor)}</strong>
                    <small>
                      {hidden || c.pctOfIncome === undefined
                        ? ""
                        : pct(c.pctOfIncome, 0) + " del ingreso"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Sin cargos en los ciclos actuales.</p>
            )}
            {data.leak && data.leak.rows.length > 0 && (
              <p className="fin-note">
                Fuga habitual, últimos {data.leak.days} días:{" "}
                <strong>{show(data.leak.perDayMinor)} al día</strong> (
                {show(data.leak.totalMinor)} en{" "}
                {data.leak.rows.map((r) => r.category.toLowerCase()).join(", ")}
                ).
              </p>
            )}
          </section>

          <section id="financial-movements">
            <div className="filter-bar">
              <SectionTitle title="Movimientos" count={rows.length} />
              <input
                type="search"
                className="month-picker"
                placeholder="Buscar"
                aria-label="Buscar movimientos"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="month-picker"
                aria-label="Mes"
                value={month === "all" ? "all" : activeMonth || "all"}
                onChange={(e) => setMonth(e.target.value)}
              >
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
                <option value="all">Todos</option>
              </select>
            </div>
            {cardFilter && (
              <button className="text-link" onClick={() => setCardFilter("")}>
                Quitar filtro: {cards.find((c) => c.id === cardFilter)?.name}
              </button>
            )}
            <div className="transaction-list">
              {rows.length ? (
                rows.map((t) => {
                  const credit = CREDIT.includes(t.type);
                  return (
                    <button
                      key={t.id}
                      className="transaction-row"
                      onClick={() => setDialog({ kind: "edit", tx: t })}
                    >
                      <span
                        className={
                          "transaction-icon " + (credit ? "positive" : "")
                        }
                      >
                        {credit ? (
                          <ArrowDownLeft size={17} />
                        ) : (
                          <ArrowUpRight size={17} />
                        )}
                      </span>
                      <div>
                        <strong>{t.desc}</strong>
                        <small>
                          {t.type === "payment"
                            ? "Pago de tarjeta · no es gasto"
                            : t.type === "cashback"
                              ? "Cashback · no es gasto"
                              : t.category || "Sin identificar"}{" "}
                          · {t.cardName}
                          {t.status === "pending" ? " · en proceso" : ""}
                        </small>
                      </div>
                      <span className="transaction-value">
                        <strong className={credit ? "credit" : ""}>
                          {hidden
                            ? "••••••"
                            : (credit ? "+" : "−") +
                              money(Math.abs(t.amountMinor))}
                        </strong>
                        <small>{dateLabel(t.date)}</small>
                      </span>
                    </button>
                  );
                })
              ) : (
                <Empty heading="Sin movimientos con este filtro." />
              )}
            </div>
          </section>
        </div>

        <aside>
          <SectionTitle title="Próximas fechas" />
          {data.upcoming?.length ? (
            data.upcoming.map((u, i) => (
              <div className="obligation" key={u.date + u.type + i}>
                <span className="obligation-date">
                  <strong>{u.date.slice(8)}</strong>
                  <small>{dateLabel(u.date, { month: "short" })}</small>
                </span>
                <span>
                  <strong>{u.label}</strong>
                  <small>
                    {u.type === "due"
                      ? `${show(u.amountMinor)}${u.estimated ? " · fecha estimada" : ""}${u.overdue ? " · ya pasó" : ""}`
                      : "Corte"}
                  </small>
                </span>
              </div>
            ))
          ) : (
            <p className="muted">Sin fechas próximas registradas.</p>
          )}

          <SectionTitle
            title="Mensualidades"
            count={data.installments?.filter((i) => !i.done).length}
          />
          {data.installments
            ?.filter((i) => !i.done)
            .map((i) => (
              <div className="fin-installment" key={i.id}>
                <div>
                  <strong>{i.label}</strong>
                  <span>{show(i.monthlyMinor)}</span>
                </div>
                <div className="fin-bar">
                  <i
                    style={{ width: hidden ? "0%" : pct(i.paid / i.months) }}
                  />
                </div>
                <small>
                  {i.paid} de {i.months} · quedan {show(i.remainingMinor)}
                  {i.estimated ? " · monto estimado" : ""}
                </small>
              </div>
            ))}
          <p className="fin-note">
            Quedan {show(data.installmentsRemainingMinor)} en total. Los
            contadores son los reportados, no prueban pagos liquidados.
          </p>

          <SectionTitle title="Cargos fijos" />
          {data.commitments?.length ? (
            data.commitments.map((c) => (
              <div className="fin-fixed" key={c.id}>
                <span>
                  {c.label}
                  <small>{c.cardName}</small>
                </span>
                <strong>{show(c.amountMinor)}</strong>
              </div>
            ))
          ) : (
            <p className="muted">Sin cargos fijos.</p>
          )}

          {data.questions && data.questions.length > 0 && (
            <>
              <SectionTitle
                title="Pendientes por confirmar"
                count={data.questions.length}
              />
              {data.questions.map((q) => (
                <div className="fin-question" key={q.id}>
                  <p>{q.text}</p>
                  <button
                    className="text-link"
                    onClick={() =>
                      void run({ op: "question-resolve", id: q.id })
                    }
                  >
                    Ya está resuelto
                  </button>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>

      {legacy && <LegacyLedger />}

      {dialog?.kind === "tx" && (
        <TxDialog
          data={data}
          run={run}
          onClose={closeDialog}
          initialCard={cardFilter}
        />
      )}
      {dialog?.kind === "agent" && (
        <UpdateWithAgent
          data={data}
          run={run}
          hidden={hidden}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "card" && (
        <CardDialog
          data={data}
          run={run}
          onClose={closeDialog}
          cardId={dialog.card}
        />
      )}
      {dialog?.kind === "edit" && (
        <TxEditDialog
          tx={dialog.tx}
          categories={categories}
          run={run}
          onClose={closeDialog}
        />
      )}
    </>
  );
}

function CardTile({
  card: c,
  show,
  hidden,
  selected,
  onSelect,
  onEdit,
}: {
  card: FinCard;
  show: (n?: number) => string;
  hidden: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const due =
    c.daysToDue === undefined
      ? "Fecha límite por confirmar"
      : c.daysToDue < 0
        ? `Venció el ${dateLabel(c.dueDate)}`
        : `Vence ${dateLabel(c.dueDate)}${c.dueEstimated ? " (estimada)" : ""}`;
  return (
    <div className={"fin-card" + (selected ? " selected" : "")}>
      <button
        className="fin-card-main"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="fin-card-name">
          {c.name}
          {c.last4 && <small> ····{c.last4}</small>}
        </span>
        <span className="card-pay-label">Pago del periodo</span>
        <strong>{show(c.payMinor)}</strong>
        <span className="card-due-date">{due}</span>
        <div
          className="fin-bar"
          title={hidden ? "Crédito oculto" : pct(c.usedPct, 1) + " del límite"}
        >
          <i style={{ width: hidden ? "0%" : pct(Math.min(1, c.usedPct)) }} />
        </div>
        <small>
          {hidden
            ? "Crédito oculto"
            : `${pct(c.usedPct, 1)} del límite usado · ${show(c.availableMinor)} disponibles`}
        </small>
        <dl>
          <div>
            <dt>Deuda total</dt>
            <dd>{show(c.balanceMinor)}</dd>
          </div>
          <div>
            <dt>Cargos del ciclo</dt>
            <dd>{show(c.cycleChargesMinor)}</dd>
          </div>
          <div>
            <dt>Corte</dt>
            <dd>
              {c.cutDate ? dateLabel(c.cutDate) : "Por confirmar"}
              {c.daysToCut !== undefined && c.daysToCut >= 0
                ? ` · en ${c.daysToCut} d`
                : c.cutPassed
                  ? " · ya pasó"
                  : ""}
            </dd>
          </div>
          <div>
            <dt>Límite</dt>
            <dd>{show(c.limitMinor)}</dd>
          </div>
        </dl>
      </button>
      <footer className={c.stale ? "stale" : ""}>
        <span>
          {c.asOf ? `Saldo al ${dateLabel(c.asOf)}` : "Saldo sin verificar"}
          {c.stale && c.ageDays ? ` · hace ${c.ageDays} d` : ""}
        </span>
        <button className="text-link" onClick={onEdit}>
          Actualizar
        </button>
      </footer>
    </div>
  );
}
