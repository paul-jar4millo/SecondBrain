import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useId,
  useState,
  type ReactNode,
} from "react";
import { X, ArrowUpRight, Plus, ChevronDown, Search } from "lucide-react";
import { Link } from "react-router-dom";
import {
  type Item,
  type Kind,
  newItem,
  today,
  money,
  privateMoney,
} from "../core/model";
import { labels } from "./item-labels";
import { searchableItems } from "../core/overview";
import type { AgentTarget, TeamTarget } from "../features/team/team-controller";
export const UI = createContext<{
  items: Item[];
  edit: (item: Item | Kind) => void;
  notify: (s: string) => void;
  trash: (item: Item) => void;
  /** Opens the agent handoff with a ready-to-copy prompt. */
  ask: (prompt: string) => void;
  openAgent: (target: AgentTarget) => void;
  openTeam: (target?: TeamTarget) => void;
}>({
  items: [],
  edit: () => {},
  notify: () => {},
  trash: () => {},
  ask: () => {},
  openAgent: () => {},
  openTeam: () => {},
});
export const useUI = () => useContext(UI);
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  onEscape,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  onEscape?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`${wide ? "modal wide" : "modal"} ${className}`}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        // Handle before the native close watcher so replacing a focused profile
        // cannot also dismiss the enclosing dialog in the same Escape gesture.
        e.preventDefault();
        e.stopPropagation();
        (onEscape || onClose)();
      }}
      onCancel={(e) => {
        e.preventDefault();
        (onEscape || onClose)();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="Cerrar" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  heading,
  action,
}: {
  heading: string;
  action?: ReactNode;
}) {
  return (
    <p className="empty">
      {heading}
      {action}
    </p>
  );
}
export function SectionTitle({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {action}
    </div>
  );
}
export function MoreLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link className="text-link" to={to}>
      {children}
      <ArrowUpRight size={14} />
    </Link>
  );
}
export { ItemEditor } from "./ItemEditor";
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { items, edit } = useUI();
  const [query, setQuery] = useState("");
  const results = searchableItems(items)
    .filter(
      (x) =>
        !x.deleted &&
        x.kind !== "account" &&
        x.kind !== "transaction" &&
        x.kind !== "notification" &&
        (
          x.title +
          " " +
          (x.kind === "project" ? "" : x.body || "") +
          " " +
          (x.tags || []).join(" ")
        )
          .toLocaleLowerCase("es")
          .includes(query.toLocaleLowerCase("es")),
    )
    .slice(0, 15);
  return (
    <Modal title="Buscar en tu espacio" onClose={onClose}>
      <label className="search-input">
        <Search size={19} />
        <input
          autoFocus
          aria-label="Buscar"
          placeholder="Una idea, una tarea, un proyecto…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="search-results">
        {query ? (
          results.length ? (
            results.map((x) => (
              <button
                key={x.id}
                onClick={() => {
                  edit(x);
                  onClose();
                }}
              >
                <span>
                  <small>{labels[x.kind]}</small>
                  {x.title}
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <Empty heading="Sin resultados." />
          )
        ) : (
          <p className="muted">
            Busca por título, contenido o etiqueta. Los resultados incluyen los
            cambios guardados en este dispositivo.
          </p>
        )}
      </div>
    </Modal>
  );
}
export function SelectFilter({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  label: string;
}) {
  return (
    <label className="select-filter">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}
export function AddButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="button primary" onClick={onClick}>
      <Plus size={16} />
      {children}
    </button>
  );
}
export function TransactionDetail({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { items, edit } = useUI();
  return (
    <Modal title="Detalle del movimiento" onClose={onClose}>
      <h3>{item.title}</h3>
      <p className="detail-amount">{privateMoney(item.amountMinor)}</p>
      <dl className="detail-list">
        <dt>Cuenta</dt>
        <dd>{items.find((x) => x.id === item.accountId)?.title}</dd>
        <dt>Tipo</dt>
        <dd>
          {{
            expense: "Gasto",
            income: "Ingreso",
            payment: "Pago de tarjeta",
            transfer: "Transferencia",
            refund: "Devolución",
            opening: "Saldo inicial",
            opening_debt: "Deuda inicial",
          }[item.transactionType || ""] || item.transactionType}
        </dd>
        <dt>Fecha</dt>
        <dd>{item.date}</dd>
        <dt>Estado</dt>
        <dd>{item.status === "draft" ? "Borrador" : "Confirmado"}</dd>
        <dt>Categoría</dt>
        <dd>{item.category || "Por clasificar"}</dd>
        {item.installments && (
          <>
            <dt>Compromiso MSI</dt>
            <dd>
              {item.installments} cuotas de aproximadamente{" "}
              {money(Math.ceil((item.amountMinor || 0) / item.installments))}.
              No vuelve a sumarse como gasto.
            </dd>
          </>
        )}
      </dl>
      <p className="form-hint">
        El registro confirmado se conserva. Una devolución se añade como
        movimiento separado con su fecha real.
      </p>
      <div className="modal-actions">
        <span className="spacer" />
        {item.transactionType === "expense" && (
          <button
            className="button"
            onClick={() => {
              onClose();
              edit(
                newItem("transaction", {
                  title: "Devolución · " + item.title,
                  transactionType: "refund",
                  accountId: item.accountId,
                  amountMinor: item.amountMinor,
                  category: item.category,
                  date: today(),
                  source: item.id,
                }),
              );
            }}
          >
            Registrar devolución
          </button>
        )}
        <button className="button primary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Modal>
  );
}
