import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Pin, PinOff, RotateCcw, Trash2, Upload } from "lucide-react";
import { api, isDemo, ownerName } from "../../core/store";
import { subscribeChanges } from "../../core/events";
import { PageHeading } from "../../components/PageHeading";
import { useUI } from "../../components/ui";
import { uploadForAgents } from "./upload";
import "./files.css";

type Area = "para-agentes" | "de-agentes";
interface Entry {
  id: string;
  area: Area;
  name: string;
  size: number;
  actor: string;
  note: string;
  pinned: boolean;
  createdAt: string;
  expiresAt: string | null;
}
interface Listing {
  files: Entry[];
  trash: Entry[];
}

export const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const who = (actor: string) =>
  actor.startsWith("agente:")
    ? actor.slice(7)
    : actor === "app"
      ? ownerName || "Tú"
      : actor;

export function FilesPage() {
  const [data, setData] = useState<Listing>({ files: [], trash: [] });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { notify } = useUI();

  const load = useCallback(() => {
    if (isDemo) return;
    api<Listing>("/files")
      .then((value: Listing) => {
        setData(value);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    return subscribeChanges(load);
  }, [load]);

  async function upload(list: FileList | File[]) {
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        try {
          await uploadForAgents(file);
        } catch (e) {
          notify(`${file.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      setBusy(false);
      load();
    }
  }
  const act = (path: string, body: object) =>
    api(path, { method: "POST", body: JSON.stringify(body) })
      .then(load)
      .catch((e: Error) => notify(e.message));

  const column = (area: Area, title: string, hint: string) => {
    const files = data.files.filter((f) => f.area === area);
    return (
      <section className="files-column" aria-label={title}>
        <h2>{title}</h2>
        <p className="muted">{hint}</p>
        {files.length === 0 ? (
          <p className="files-empty">Todavía no hay archivos.</p>
        ) : (
          <ul className="files-list">
            {files.map((f) => (
              <li key={f.id}>
                <div className="files-meta">
                  <strong>{f.name}</strong>
                  <span className="muted">
                    {sizeLabel(f.size)} · {who(f.actor)} ·{" "}
                    {new Date(f.createdAt).toLocaleString("es-MX")}
                    {f.expiresAt
                      ? ` · caduca ${new Date(f.expiresAt).toLocaleDateString("es-MX")}`
                      : " · fijado"}
                  </span>
                  {f.note && <span className="files-note">{f.note}</span>}
                </div>
                <div className="files-actions">
                  <a
                    className="icon-button"
                    href={`/api/v1/files/download?id=${f.id}`}
                    download={f.name}
                    aria-label={`Descargar ${f.name}`}
                  >
                    <Download size={16} />
                  </a>
                  <button
                    className="icon-button"
                    aria-label={(f.pinned ? "Desfijar " : "Fijar ") + f.name}
                    onClick={() =>
                      act("/files/pin", { id: f.id, pinned: !f.pinned })
                    }
                  >
                    {f.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Quitar ${f.name}`}
                    onClick={() => act("/files/trash", { id: f.id })}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="files-page">
      <PageHeading
        title="Maletín"
        description="Carpeta compartida con las agentes. Admite cualquier tipo de archivo, hasta 100 MB cada uno; caduca a los 30 días si no lo fijas."
      />
      {isDemo ? (
        <p role="status">El Maletín no está disponible en el modo demo.</p>
      ) : (
        <>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div
            className={"files-drop" + (over ? " over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void upload(e.dataTransfer.files);
            }}
          >
            <Upload size={22} aria-hidden />
            <p>Arrastra archivos aquí para dejarlos a las agentes</p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? "Subiendo…" : "Elegir archivos"}
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="Elegir archivos para las agentes"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="files-columns">
            {column(
              "para-agentes",
              "Para las agentes",
              "Lo que dejaste. Ellas solo lo leen.",
            )}
            {column(
              "de-agentes",
              "De las agentes",
              "Lo que te entregaron. Descárgalo o quítalo.",
            )}
          </div>
          {data.trash.length > 0 && (
            <details className="files-trash">
              <summary>
                Papelera ({data.trash.length}) · se vacía a los 7 días
              </summary>
              <ul className="files-list">
                {data.trash.map((f) => (
                  <li key={f.id}>
                    <div className="files-meta">
                      <strong>{f.name}</strong>
                      <span className="muted">{sizeLabel(f.size)}</span>
                    </div>
                    <div className="files-actions">
                      <button
                        className="icon-button"
                        aria-label={`Restaurar ${f.name}`}
                        onClick={() => act("/files/restore", { id: f.id })}
                      >
                        <RotateCcw size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
