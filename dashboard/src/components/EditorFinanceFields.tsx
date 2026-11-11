import type { ReactNode } from "react";
import type { Item } from "../core/model";
interface Props {
  item: Item;
  accounts: Item[];
  amount: string;
  statementAmounts: Record<string, string>;
  setField: (field: keyof Item, value: unknown) => void;
  setAmount: (value: string) => void;
  setStatementAmounts: (value: Record<string, string>) => void;
  field: (
    label: string,
    key: keyof Item,
    type?: string,
    required?: boolean,
  ) => ReactNode;
}
export function EditorFinanceFields({
  item,
  accounts,
  amount,
  statementAmounts,
  setField,
  setAmount,
  setStatementAmounts,
  field,
}: Props) {
  const kind = item.kind;
  return (
    <>
      {kind === "account" && (
        <label className="field">
          Tipo
          <select
            value={item.accountType || "asset"}
            onChange={(e) => setField("accountType", e.target.value)}
          >
            <option value="asset">Débito / efectivo</option>
            <option value="credit">Tarjeta de crédito</option>
          </select>
          <small>
            Los saldos se registran con un movimiento de apertura. No guardes
            números de tarjeta.
          </small>
        </label>
      )}
      {kind === "transaction" && (
        <>
          <div className="form-grid">
            <label className="field">
              Tipo
              <select
                value={item.transactionType || "expense"}
                onChange={(e) => setField("transactionType", e.target.value)}
              >
                <option value="expense">Gasto</option>
                <option value="income">Ingreso</option>
                <option value="payment">Pago de tarjeta</option>
                <option value="transfer">Transferencia</option>
                <option value="refund">Devolución de gasto</option>
                <option value="opening">Saldo inicial a favor</option>
                <option value="opening_debt">Deuda inicial de tarjeta</option>
              </select>
            </label>
            <label className="field">
              Importe · MXN
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                required
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="field">
              {["payment", "transfer"].includes(item.transactionType || "")
                ? "Desde la cuenta"
                : "Cuenta"}
              <select
                required
                value={item.accountId || ""}
                onChange={(e) => setField("accountId", e.target.value)}
              >
                <option value="">Seleccionar…</option>
                {accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
            {["payment", "transfer"].includes(item.transactionType || "") && (
              <label className="field">
                Hacia la cuenta
                <select
                  value={item.otherAccountId || ""}
                  onChange={(e) => setField("otherAccountId", e.target.value)}
                >
                  <option value="">Seleccionar…</option>
                  {accounts
                    .filter((a) => a.id !== item.accountId)
                    .map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {field("Fecha de operación", "date", "date")}
            <label className="field">
              Categoría
              <select
                value={item.category || ""}
                onChange={(e) => setField("category", e.target.value)}
              >
                <option value="">Por clasificar</option>
                {[
                  "Comida",
                  "Transporte",
                  "Personal",
                  "Salud",
                  "Educación",
                  "Servicios",
                  "Hogar",
                  "Entretenimiento",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {item.transactionType !== "payment" && (
              <label className="field">
                Cuotas MSI (solo proyección)
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={item.installments || ""}
                  onChange={(e) =>
                    setField(
                      "installments",
                      Number(e.target.value) || undefined,
                    )
                  }
                />
              </label>
            )}
          </div>
          <p className="form-hint">
            Un pago de tarjeta mueve dinero entre cuentas; no vuelve a contarse
            como gasto. Los movimientos confirmados se conservan en el registro.
          </p>
        </>
      )}
      {kind === "statement" && (
        <div className="form-grid">
          <label className="field">
            Tarjeta
            <select
              required
              value={item.accountId || ""}
              onChange={(e) => setField("accountId", e.target.value)}
            >
              <option value="">Seleccionar…</option>
              {accounts
                .filter((a) => a.accountType === "credit")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
          {field("Fecha de corte", "date", "date", true)}
          {field("Vencimiento exacto", "dueDate", "date", true)}
          {[
            ["minimumMinor", "Pago mínimo"],
            ["noInterestMinor", "Para no generar intereses"],
            ["statementBalanceMinor", "Saldo del corte"],
          ].map(([key, label]) => (
            <label className="field" key={key}>
              {label} · MXN
              <input
                inputMode="decimal"
                value={statementAmounts[key]}
                onChange={(e) =>
                  setStatementAmounts({
                    ...statementAmounts,
                    [key]: e.target.value,
                  })
                }
                placeholder="Sin confirmar"
              />
            </label>
          ))}
          {field("Fuente del dato", "source")}
          {field("Verificado el", "verifiedAt", "date")}
          <label className="field">
            Estado
            <select
              value={item.status || "pending"}
              onChange={(e) => setField("status", e.target.value)}
            >
              <option value="pending">Pago por revisar</option>
              <option value="done">Revisado / resuelto</option>
            </select>
          </label>
          <p className="form-hint">
            Los tres importes son independientes. Guardarlos no registra un pago
            ni cambia el saldo contable.
          </p>
        </div>
      )}
      {kind === "obligation" && (
        <div className="form-grid">
          <label className="field">
            Estado
            <select
              value={item.status || "pending"}
              onChange={(e) => setField("status", e.target.value)}
            >
              <option value="pending">Pendiente</option>
              <option value="done">Resuelto</option>
            </select>
          </label>
          {field("Vencimiento", "date", "date", true)}
          <label className="field">
            Importe previsto · MXN
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>
      )}
    </>
  );
}
