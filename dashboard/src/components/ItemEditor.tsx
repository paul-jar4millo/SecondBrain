import { EditorFinanceFields } from "./EditorFinanceFields";
import { useItemDraft } from "./useItemDraft";
import { editorValue } from "./editor-value";
import { useState, type FormEvent } from "react";
import { Trash2, Check } from "lucide-react";
import { type Item, type Kind, active, newItem } from "../core/model";
import { save } from "../core/store";
import { Modal, useUI } from "./ui";
import { labels } from "./item-labels";
export function ItemEditor({
  value,
  onClose,
}: {
  value: Item | Kind;
  onClose: () => void;
}) {
  const { items, notify, trash } = useUI();
  const rawInitial = typeof value === "string" ? newItem(value) : value;
  const initial =
    rawInitial.kind === "project" &&
    (!rawInitial.status || rawInitial.status === "pending")
      ? { ...rawInitial, status: "active" }
      : rawInitial;
  const [item, set] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState(
    initial.amountMinor ? String(initial.amountMinor / 100) : "",
  );
  const [statementAmounts, setStatementAmounts] = useState<
    Record<string, string>
  >(
    Object.fromEntries(
      ["minimumMinor", "noInterestMinor", "statementBalanceMinor"].map((k) => [
        k,
        initial[k as keyof Item] === undefined
          ? ""
          : String(Number(initial[k as keyof Item]) / 100),
      ]),
    ),
  );
  const isNew = !items.some((x) => x.id === item.id);
  const setField = (field: keyof Item, v: unknown) =>
    set((x) => ({ ...x, [field]: v }));
  const kind = item.kind;
  const [changeKind, setChangeKind] = useState(false);
  const draftKey =
    typeof value === "string" ? "draft:new:" + value : "draft:" + value.id;
  const { draftStatus, saved } = useItemDraft(draftKey, item, set);
  const accounts = active(items, "account");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload =
        kind === "project" && (!item.status || item.status === "pending")
          ? { ...item, status: "active" }
          : item;
      const result = editorValue(payload, amount, statementAmounts);
      await save(result);
      await saved();
      notify(isNew ? "Guardado." : "Cambios guardados.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    label: string,
    key: keyof Item,
    type = "text",
    required = false,
  ) => (
    <label className="field">
      {label}
      <input
        type={type}
        value={String(item[key] || "")}
        required={required}
        onChange={(e) => setField(key, e.target.value)}
      />
    </label>
  );
  return (
    <Modal
      title={`${isNew ? (["project", "event", "transaction", "obligation", "statement"].includes(kind) ? "Nuevo" : "Nueva") : "Editar"} ${labels[kind]}`}
      onClose={onClose}
      wide={kind === "note"}
    >
      <form onSubmit={submit}>
        {isNew && ["inbox", "task", "note", "event"].includes(kind) && (
          <div className="capture-types">
            {(["task", "event"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={kind === k ? "selected" : ""}
                onClick={() => {
                  setField("kind", k);
                  setChangeKind(true);
                }}
              >
                {labels[k][0].toUpperCase() + labels[k].slice(1)}
              </button>
            ))}
          </div>
        )}
        {field(
          kind === "transaction" ? "Concepto" : "Título",
          "title",
          "text",
          true,
        )}
        {!["account", "transaction", "project"].includes(kind) && (
          <label className="field">
            {kind === "note" ? "Contenido · Markdown" : "Detalles (opcional)"}
            <textarea
              rows={kind === "note" ? 12 : 3}
              value={item.body || ""}
              placeholder={
                kind === "inbox"
                  ? "Puedes darle forma después."
                  : kind === "note"
                    ? "Empieza por una idea. Usa Markdown o [[enlaces]]."
                    : "Añade un poco de contexto…"
              }
              onChange={(e) => setField("body", e.target.value)}
            />
          </label>
        )}
        {["task", "project", "note", "event"].includes(kind) && (
          <div className="form-grid">
            {kind !== "project" && (
              <label className="field">
                Proyecto
                <select
                  value={item.projectId || ""}
                  onChange={(e) => setField("projectId", e.target.value)}
                >
                  <option value="">Sin proyecto</option>
                  {active(items, "project").map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {field("Área", "area")}
            {["task", "project", "event"].includes(kind) &&
              field(
                kind === "event" ? "Fecha de inicio" : "Fecha límite",
                "date",
                "date",
                kind === "event",
              )}
            {kind === "task" && field("Día planeado", "plannedDate", "date")}
            {kind === "event" && (
              <>
                {field("Hora de inicio (vacía = todo el día)", "time", "time")}
                {field("Hora de fin", "endTime", "time")}
                {field(
                  "Fecha de fin (exclusiva si todo el día)",
                  "endDate",
                  "date",
                )}
                {field("Zona horaria", "timezone")}
              </>
            )}
            {kind === "task" && (
              <label className="field">
                Repetición
                <select
                  value={item.recurrence || ""}
                  onChange={(e) => setField("recurrence", e.target.value)}
                >
                  <option value="">No se repite</option>
                  <option value="daily">Cada día</option>
                  <option value="weekly">Cada semana</option>
                  <option value="monthly">
                    Cada mes (último día si no existe)
                  </option>
                </select>
              </label>
            )}
            {["task", "project"].includes(kind) && (
              <label className="field">
                Estado
                <select
                  value={
                    kind === "project"
                      ? !item.status || item.status === "pending"
                        ? "active"
                        : item.status
                      : item.status || "pending"
                  }
                  onChange={(e) => setField("status", e.target.value)}
                >
                  {(kind === "task"
                    ? [
                        ["pending", "Pendiente"],
                        ["doing", "En curso"],
                        ["waiting", "En espera"],
                        ["done", "Completada"],
                        ["cancelled", "Cancelada"],
                      ]
                    : [
                        ["active", "En marcha"],
                        ["paused", "Pausado"],
                        ["done", "Completado"],
                        ["archived", "Archivado"],
                      ]
                  ).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind === "note" && (
              <>
                {field("Verificado el", "verifiedAt", "date")}
                {field("Revisar antes de", "expiresAt", "date")}
                <label className="field">
                  Etiquetas (separadas por comas)
                  <input
                    value={item.tags?.join(", ") || ""}
                    onChange={(e) =>
                      setField(
                        "tags",
                        e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </label>
              </>
            )}
          </div>
        )}
        <EditorFinanceFields
          item={item}
          accounts={accounts}
          amount={amount}
          statementAmounts={statementAmounts}
          setField={setField}
          setAmount={setAmount}
          setStatementAmounts={setStatementAmounts}
          field={field}
        />
        {draftStatus && <p className="draft-status">{draftStatus}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {!isNew && kind !== "transaction" && (
            <button
              type="button"
              className="button danger subtle"
              onClick={() => {
                trash(item);
                onClose();
              }}
            >
              <Trash2 size={16} />
              Papelera
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button subtle" onClick={onClose}>
            Cancelar
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Guardando…" : isNew ? "Guardar" : "Guardar cambios"}
            <Check size={16} />
          </button>
        </div>
        {changeKind && (
          <span className="sr-only">Tipo cambiado a {labels[kind]}</span>
        )}
      </form>
    </Modal>
  );
}
