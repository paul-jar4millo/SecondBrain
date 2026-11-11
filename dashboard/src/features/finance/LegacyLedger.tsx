import { useState } from "react";
import {
  Plus,
  ArrowUpRight,
  ArrowDownLeft,
  ChevronRight,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  active,
  today,
  dateLabel,
  money,
  balance,
  expenses,
} from "../../core/model";
import { useUI, Empty, SectionTitle, AddButton } from "../../components/ui";
import { PageHeading } from "../../components/PageHeading";
import { MonthPicker } from "../../components/MonthPicker";
export function LegacyLedger() {
  const { items, edit } = useUI();
  const [hidden, setHidden] = useState(
    localStorage.getItem("sb-hide-money") === "true",
  );
  const [filter, setFilter] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7));
  const accounts = active(items, "account");
  const invalid = items.filter(
    (i) =>
      ["account", "transaction", "statement"].includes(i.kind) &&
      i.validationErrors?.length,
  );
  const transactions = active(items, "transaction")
    .filter(
      (t) =>
        t.date?.startsWith(month) &&
        (!filter || t.accountId === filter || t.otherAccountId === filter),
    )
    .sort(
      (a, b) =>
        (b.date || "").localeCompare(a.date || "") ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const obligations = [
    ...active(items, "obligation"),
    ...active(items, "statement").map((s) => ({
      ...s,
      date: s.dueDate,
      amountMinor: s.noInterestMinor,
    })),
  ]
    .filter((o) => o.status !== "done")
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const show = (n?: number) =>
    hidden ? "••••••" : n === undefined ? "Por confirmar" : money(n);
  return (
    <>
      <PageHeading
        title="Finanzas"
        description="Saldos y movimientos de tus cuentas manuales. Selecciona una cuenta para filtrar."
        action={
          <div className="heading-actions">
            <button
              className="icon-button"
              aria-label={hidden ? "Mostrar importes" : "Ocultar importes"}
              onClick={() => {
                setHidden(!hidden);
                localStorage.setItem("sb-hide-money", String(!hidden));
                window.dispatchEvent(new Event("sb-money-visibility"));
              }}
            >
              {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
            <AddButton
              onClick={() => edit(accounts.length ? "transaction" : "account")}
            >
              {accounts.length ? "Registrar movimiento" : "Añadir cuenta"}
            </AddButton>
          </div>
        }
      />
      {invalid.length > 0 && (
        <div className="notice warning">
          {invalid.length} registros del vault necesitan corregirse. Los
          movimientos inválidos no se suman a los totales.{" "}
          {invalid.map((i) => (
            <button className="text-link" key={i.id} onClick={() => edit(i)}>
              {i.title}: {i.validationErrors?.join(" ")}
            </button>
          ))}
        </div>
      )}
      {!accounts.length ? (
        <Empty heading="Aún no tienes cuentas registradas." />
      ) : (
        <>
          <div className="account-strip">
            {accounts.map((a) => {
              const b = balance(items, a.id);
              return (
                <button
                  key={a.id}
                  className={filter === a.id ? "selected" : ""}
                  onClick={() => setFilter(filter === a.id ? "" : a.id)}
                >
                  <span>{a.title}</span>
                  <strong>{show(a.accountType === "credit" ? -b : b)}</strong>
                  <small>
                    {a.accountType === "credit"
                      ? b > 0
                        ? "Saldo a favor"
                        : "Deuda registrada"
                      : "Saldo registrado"}{" "}
                    · MXN
                  </small>
                </button>
              );
            })}
            <button className="add-account" onClick={() => edit("account")}>
              <Plus size={18} />
              <span>Añadir cuenta</span>
            </button>
          </div>
          <div className="finance-layout">
            <section>
              <div className="finance-summary">
                <div>
                  <span>Gasto del mes</span>
                  <strong>{show(expenses(items, month))}</strong>
                </div>
                <p>
                  Los pagos de tarjeta y las transferencias no se cuentan como
                  gasto.
                </p>
              </div>
              <div className="filter-bar">
                <SectionTitle title="Movimientos" count={transactions.length} />
                <MonthPicker value={month} onChange={setMonth} />
              </div>
              {filter && (
                <button
                  className="text-link"
                  onClick={() => edit(accounts.find((a) => a.id === filter)!)}
                >
                  Editar cuenta seleccionada
                </button>
              )}
              <div className="transaction-list">
                {transactions.length ? (
                  transactions.map((t) => (
                    <button
                      key={t.id}
                      className="transaction-row"
                      onClick={() => edit(t)}
                    >
                      <span
                        className={
                          "transaction-icon " +
                          (["income", "refund", "opening"].includes(
                            t.transactionType || "",
                          )
                            ? "positive"
                            : "")
                        }
                      >
                        {["income", "refund", "opening"].includes(
                          t.transactionType || "",
                        ) ? (
                          <ArrowDownLeft size={17} />
                        ) : (
                          <ArrowUpRight size={17} />
                        )}
                      </span>
                      <div>
                        <strong>{t.title}</strong>
                        <small>
                          {t.transactionType === "payment"
                            ? "Pago de tarjeta · no es gasto"
                            : t.transactionType === "transfer"
                              ? "Transferencia interna"
                              : t.category || "Por clasificar"}{" "}
                          · {items.find((a) => a.id === t.accountId)?.title}
                        </small>
                      </div>
                      <span className="transaction-value">
                        <strong>{show(t.amountMinor)}</strong>
                        <small>{dateLabel(t.date)}</small>
                      </span>
                    </button>
                  ))
                ) : (
                  <Empty heading="Sin movimientos en este mes." />
                )}
              </div>
            </section>
            <aside>
              <SectionTitle
                title="Próximos compromisos"
                action={
                  <button
                    className="icon-button"
                    aria-label="Añadir compromiso"
                    onClick={() => edit("obligation")}
                  >
                    <Plus size={17} />
                  </button>
                }
              />
              {obligations.length ? (
                obligations.map((o) => (
                  <button
                    className="obligation"
                    key={o.id}
                    onClick={() => edit(items.find((x) => x.id === o.id)!)}
                  >
                    <span className="obligation-date">
                      <strong>{o.date?.slice(8)}</strong>
                      <small>{dateLabel(o.date, { month: "short" })}</small>
                    </span>
                    <span>
                      <strong>{o.title}</strong>
                      <small>{show(o.amountMinor)} · Por confirmar</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))
              ) : (
                <p className="muted">
                  Añade pagos o suscripciones que quieras tener presentes.
                </p>
              )}
              <SectionTitle
                title="Estados de cuenta"
                action={
                  <button
                    className="icon-button"
                    aria-label="Añadir estado de cuenta"
                    onClick={() => edit("statement")}
                  >
                    <Plus size={17} />
                  </button>
                }
              />
              {active(items, "statement").map((s) => (
                <button
                  key={s.id}
                  className="statement-row"
                  onClick={() => edit(s)}
                >
                  <strong>{s.title}</strong>
                  <small>
                    Corte {dateLabel(s.date)} · vence {dateLabel(s.dueDate)}
                  </small>
                  <span>
                    {s.noInterestMinor === undefined
                      ? "Pago por confirmar"
                      : show(s.noInterestMinor)}
                  </span>
                </button>
              ))}
              {!active(items, "statement").length && (
                <p className="muted">
                  Registra mínimo, saldo de corte y pago para no generar
                  intereses como cifras independientes.
                </p>
              )}
              <div className="finance-footnote">
                <p>
                  Los saldos salen de los movimientos registrados. Compruébalos
                  con el estado de cuenta; un importe previsto no confirma un
                  pago.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
