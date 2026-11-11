import { useState } from "react";
import { Modal, useUI } from "../../components/ui";
import { active, money, type Item } from "../../core/model";
import { csvItems, parseCSV, type CSVMapping } from "../../lib/csv";
import { importItems } from "../../core/store";
export function CSVImport({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  const { items, notify } = useUI();
  let rows: string[][] = [];
  let parseError = "";
  try {
    rows = parseCSV(text);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const headers = rows[0] || [];
  const index = (pattern: RegExp) => headers.findIndex((h) => pattern.test(h));
  const [mapping, setMapping] = useState<CSVMapping>({
    date: index(/fecha|date/i),
    title: index(/concepto|descrip|title|comercio/i),
    amount: index(/importe|monto|amount/i),
    account: index(/^cuenta$|account/i),
    type: index(/^tipo$|^type$/i),
    category: index(/categor/i),
    otherAccount: index(/destino|other/i),
    defaultAccount: active(items, "account")[0]?.id || "",
    defaultType: "expense",
    dateFormat: "ISO",
    decimal: ".",
  });
  const [preview, setPreview] = useState<Item[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState(parseError);
  const [busy, setBusy] = useState(false);
  const field = (label: string, key: keyof CSVMapping, required = false) => (
    <label className="field">
      {label}
      <select
        value={String(mapping[key])}
        onChange={(e) =>
          setMapping({ ...mapping, [key]: Number(e.target.value) })
        }
      >
        <option value={-1}>
          {required ? "Elegir columna…" : "No usar columna"}
        </option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || "Columna " + (i + 1)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Modal
      title={preview ? "Revisar movimientos" : "Importar CSV"}
      onClose={onClose}
      wide
    >
      {preview ? (
        <>
          <p className="muted">
            Desmarca lo que no quieras importar. Las coincidencias con registros
            existentes se excluyen inicialmente; puedes conservar dos compras
            legítimas idénticas.
          </p>
          <div className="import-preview">
            {preview.map((t) => (
              <label className="csv-row" key={t.id}>
                <input
                  type="checkbox"
                  checked={!excluded.has(t.id)}
                  onChange={() => {
                    const next = new Set(excluded);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    setExcluded(next);
                  }}
                />
                <span>
                  {t.date}
                  <strong>{t.title}</strong>
                </span>
                <span>{money(t.amountMinor)}</span>
                {excluded.has(t.id) && <small>Excluido</small>}
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {rows.length - 1} filas. Elige las columnas, el formato de fecha y
            los separadores. No se guarda nada hasta confirmar la vista previa.
          </p>
          <div className="form-grid csv-mapping">
            {field("Fecha", "date", true)}
            {field("Concepto", "title", true)}
            {field("Importe positivo", "amount", true)}
            {field("Tipo de movimiento", "type")}
            {field("Categoría", "category")}
            {field("Nombre de cuenta", "account")}
            {field("Nombre de cuenta de destino", "otherAccount")}
            <label className="field">
              Cuenta si no hay columna
              <select
                value={mapping.defaultAccount}
                onChange={(e) =>
                  setMapping({ ...mapping, defaultAccount: e.target.value })
                }
              >
                <option value="">Elegir cuenta…</option>
                {active(items, "account").map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Tipo si no hay columna
              <select
                value={mapping.defaultType}
                onChange={(e) =>
                  setMapping({ ...mapping, defaultType: e.target.value })
                }
              >
                <option value="expense">Gasto</option>
                <option value="income">Ingreso</option>
                <option value="refund">Devolución</option>
              </select>
            </label>
            <label className="field">
              Formato de fecha
              <select
                value={mapping.dateFormat}
                onChange={(e) =>
                  setMapping({ ...mapping, dateFormat: e.target.value })
                }
              >
                <option value="ISO">AAAA-MM-DD</option>
                <option value="DMY">DD/MM/AAAA</option>
                <option value="MDY">MM/DD/AAAA</option>
              </select>
            </label>
            <label className="field">
              Separador decimal
              <select
                value={mapping.decimal}
                onChange={(e) =>
                  setMapping({ ...mapping, decimal: e.target.value })
                }
              >
                <option value=".">Punto · 1,234.56</option>
                <option value=",">Coma · 1.234,56</option>
              </select>
            </label>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="button subtle"
          onClick={
            preview
              ? () => {
                  setPreview(null);
                  setError("");
                }
              : onClose
          }
        >
          {preview ? "Volver" : "Cancelar"}
        </button>
        <span className="spacer" />
        <button
          className="button primary"
          disabled={busy || !!parseError}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (!preview) {
                if (mapping.date < 0 || mapping.title < 0 || mapping.amount < 0)
                  throw new Error(
                    "Elige columnas de fecha, concepto e importe.",
                  );
                const data = await csvItems(
                  rows,
                  mapping,
                  active(items, "account"),
                );
                const duplicates = data.filter((t) =>
                  items.some(
                    (i) =>
                      i.id === t.id ||
                      (i.kind === "transaction" &&
                        i.date === t.date &&
                        i.title === t.title &&
                        i.amountMinor === t.amountMinor &&
                        i.accountId === t.accountId),
                  ),
                );
                setExcluded(new Set(duplicates.map((t) => t.id)));
                setPreview(data);
              } else {
                const selected = preview.filter((t) => !excluded.has(t.id));
                if (!selected.length)
                  throw new Error("Selecciona al menos un movimiento.");
                await importItems(selected);
                notify(`${selected.length} movimientos importados.`);
                onClose();
              }
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Procesando…"
            : preview
              ? "Confirmar importación"
              : "Ver vista previa"}
        </button>
      </div>
    </Modal>
  );
}
