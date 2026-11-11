import { useState, type FormEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import { Modal } from "../../components/ui";
import { useConfirmation } from "../../components/useConfirmation";
import { today } from "../../core/model";
import type { FinCard, FinTx, FinanceOverview } from "./useFinance";

type Run = (op: Record<string, unknown>) => Promise<unknown>;

function useSubmit(run: Run, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (op: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      await run(op);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
const Footer = ({
  busy,
  error,
  onClose,
  extra,
  label = "Guardar",
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  extra?: React.ReactNode;
  label?: string;
}) => (
  <>
    {error && (
      <p className="form-error" role="alert">
        {error}
      </p>
    )}
    <div className="modal-actions">
      {extra}
      <span className="spacer" />
      <button type="button" className="button subtle" onClick={onClose}>
        Cancelar
      </button>
      <button className="button primary" disabled={busy}>
        {busy ? "Guardando…" : label}
        <Check size={16} />
      </button>
    </div>
  </>
);

const KINDS = [
  { op: "charge", label: "Cargo" },
  { op: "payment", label: "Pago a tarjeta" },
  { op: "refund", label: "Reversa" },
  { op: "cashback", label: "Cashback" },
] as const;

export function TxDialog({
  data,
  run,
  onClose,
  initialCard,
}: {
  data: FinanceOverview;
  run: Run;
  onClose: () => void;
  initialCard?: string;
}) {
  const cards = data.cards || [];
  const [op, setOp] = useState<(typeof KINDS)[number]["op"]>("charge");
  const [card, setCard] = useState(initialCard || cards[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(today());
  const [category, setCategory] = useState("");
  const [pending, setPending] = useState(false);
  const { busy, error, submit } = useSubmit(run, onClose);
  const categories = [
    ...new Set(
      (data.transactions || []).map((t) => t.category).filter(Boolean),
    ),
  ] as string[];
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const hasDetails = op === "charge" || op === "refund";
    void submit({
      op,
      card,
      amount,
      desc: hasDetails ? desc || undefined : undefined,
      date,
      category: hasDetails ? category || undefined : undefined,
      status: pending ? "pending" : undefined,
    });
  };
  return (
    <Modal title="Registrar movimiento" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <div className="capture-types">
          {KINDS.map((k) => (
            <button
              key={k.op}
              type="button"
              className={op === k.op ? "selected" : ""}
              onClick={() => setOp(k.op)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            Tarjeta
            <select value={card} onChange={(e) => setCard(e.target.value)}>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Importe (MXN)
            <input
              inputMode="decimal"
              value={amount}
              required
              placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>
        {(op === "charge" || op === "refund") && (
          <label className="field">
            Concepto
            <input
              value={desc}
              required
              placeholder="Como aparece en el estado de cuenta"
              onChange={(e) => setDesc(e.target.value)}
            />
          </label>
        )}
        <div className="form-grid">
          <label className="field">
            Fecha
            <input
              type="date"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {(op === "charge" || op === "refund") && (
            <label className="field">
              Categoría
              <input
                list="fin-categories"
                value={category}
                placeholder="Si ya la conozco, la reutilizo"
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id="fin-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          )}
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={pending}
            onChange={(e) => setPending(e.target.checked)}
          />
          En proceso (no cambia el saldo hasta aplicarlo)
        </label>
        <p className="form-hint">
          Un pago no es gasto. Si no reconozco el cargo queda «Sin identificar».
        </p>
        <Footer busy={busy} error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function CardDialog({
  data,
  run,
  onClose,
  cardId,
}: {
  data: FinanceOverview;
  run: Run;
  onClose: () => void;
  cardId?: string;
}) {
  const cards = data.cards || [];
  const [id, setId] = useState(cardId || cards[0]?.id || "");
  const card = cards.find((c) => c.id === id) as FinCard | undefined;
  const pesos = (n?: number) => (n === undefined ? "" : (n / 100).toFixed(2));
  const [balance, setBalance] = useState(pesos(card?.balanceMinor));
  const [pay, setPay] = useState(pesos(card?.payMinor));
  const [cut, setCut] = useState(card?.cutDate || "");
  const [due, setDue] = useState(card?.dueDate || "");
  const [estimated, setEstimated] = useState(card?.dueEstimated ?? true);
  const { busy, error, submit } = useSubmit(run, onClose);
  const pick = (next: string) => {
    const c = cards.find((x) => x.id === next);
    setId(next);
    setBalance(pesos(c?.balanceMinor));
    setPay(pesos(c?.payMinor));
    setCut(c?.cutDate || "");
    setDue(c?.dueDate || "");
    setEstimated(c?.dueEstimated ?? true);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit({
      op: "card-set",
      card: id,
      balance,
      pay: pay || undefined,
      cutDate: cut || undefined,
      dueDate: due || undefined,
      dueEstimated: estimated,
    });
  };
  return (
    <Modal title="Actualizar tarjeta" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <label className="field">
          Tarjeta
          <select value={id} onChange={(e) => pick(e.target.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            Saldo según el banco
            <input
              inputMode="decimal"
              required
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </label>
          <label className="field">
            A pagar
            <input
              inputMode="decimal"
              value={pay}
              onChange={(e) => setPay(e.target.value)}
            />
          </label>
        </div>
        <div className="form-grid">
          <label className="field">
            Fecha de corte
            <input
              type="date"
              value={cut}
              onChange={(e) => setCut(e.target.value)}
            />
          </label>
          <label className="field">
            Fecha límite de pago
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={estimated}
            onChange={(e) => setEstimated(e.target.checked)}
          />
          La fecha límite es estimada
        </label>
        <p className="form-hint">
          Al guardar, el saldo queda verificado hoy. Si «a pagar» es mínimo o
          pago para no generar intereses, dilo en el chat con el agente.
        </p>
        <Footer busy={busy} error={error} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function TxEditDialog({
  tx,
  categories,
  run,
  onClose,
}: {
  tx: FinTx;
  categories: string[];
  run: Run;
  onClose: () => void;
}) {
  const [category, setCategory] = useState(tx.category || "");
  const { confirm, confirmation } = useConfirmation();
  const [note, setNote] = useState(tx.note || "");
  const { busy, error, submit } = useSubmit(run, onClose);
  return (
    <Modal title={tx.desc} onClose={onClose}>
      {confirmation}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ op: "tx-edit", id: tx.id, category, note });
        }}
      >
        <p className="form-hint">
          {tx.date} · {tx.cardName} ·{" "}
          {tx.status === "pending" ? "en proceso" : "aplicado"} · {tx.id}
        </p>
        <label className="field">
          Categoría
          <input
            list="fin-edit-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="fin-edit-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Nota
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Footer
          busy={busy}
          error={error}
          onClose={onClose}
          label="Guardar cambios"
          extra={
            <>
              <button
                type="button"
                className="button danger subtle"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm(
                      "¿Eliminar este movimiento? El saldo de la tarjeta se ajusta.",
                      { confirmLabel: "Eliminar", danger: true },
                    )
                  )
                    void submit({ op: "tx-delete", id: tx.id });
                }}
              >
                <Trash2 size={16} />
                Eliminar
              </button>
              {tx.status === "pending" && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void submit({ op: "settle", id: tx.id })}
                >
                  Marcar aplicado
                </button>
              )}
            </>
          }
        />
      </form>
    </Modal>
  );
}
