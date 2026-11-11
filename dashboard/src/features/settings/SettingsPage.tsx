import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Upload, RefreshCw, RotateCcw } from "lucide-react";
import { type Item } from "../../core/model";
import { useUI, SectionTitle, Modal } from "../../components/ui";
import { useConfirmation } from "../../components/useConfirmation";
import {
  type Pending,
  save,
  isDemo,
  resetDemo,
  importItems,
  db,
  resolve,
  logout,
  authEnabled,
  sync,
  api,
} from "../../core/store";
import { exportAll, exportVault, previewImport } from "../../lib/export";
import { sizeLabel } from "../files/FilesPage";
import { CSVImport } from "./CSVImport";
import { Security } from "./Security";
import { McpClients } from "./McpClients";
import { TeamSettings } from "./TeamSettings";
import { preference, setPreference } from "./preferences";
import { PageHeading } from "../../components/PageHeading";
import { getLang, LANGS, setLang, t, type Lang } from "../../core/i18n";

const QUALITY_KEY = "sb-refugio-calidad";
const BRIEFCASE_LIMIT = 2 * 1024 * 1024 * 1024;
const zones: [string, string][] = [
  ["America/Mexico_City", "Ciudad de México"],
  ["America/Monterrey", "Monterrey"],
  ["America/Tijuana", "Tijuana"],
  ["America/New_York", "Nueva York"],
  ["Europe/Madrid", "Madrid"],
  ["UTC", "Tiempo universal (UTC)"],
];
const sections = [
  ["general", "General"],
  ["equipo", "Equipo"],
  ["datos", "Datos"],
  ["seguridad", "Seguridad"],
  ["acerca", "Acerca de"],
] as const;
type Section = (typeof sections)[number][0];

const stored = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the choice simply does not persist.
  }
};

export function SettingsPage() {
  const { confirm, confirmation } = useConfirmation();
  const { items, notify, edit } = useUI();
  const [params, setParams] = useSearchParams();
  const section: Section =
    sections.find(([key]) => key === params.get("seccion"))?.[0] || "general";
  const [preview, setPreview] = useState<Item[] | null>(null);
  const [csv, setCSV] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [zone, setZone] = useState(() =>
    stored("sb-zone", "America/Mexico_City"),
  );
  const [startView, setStartView] = useState(() => preference("startView"));
  const [hideMoney, setHideMoney] = useState(
    () => stored("sb-hide-money", "false") === "true",
  );
  const [quality, setQuality] = useState(() => stored(QUALITY_KEY, "auto"));
  const [pending, setPending] = useState<Pending[]>([]);
  const [last, setLast] = useState("");
  const [briefcase, setBriefcase] = useState<number | null>(null);
  const [vault, setVault] = useState<{
    root: string;
    documents: number;
    issues: { path: string; message: string }[];
  } | null>(null);
  useEffect(() => {
    if (!isDemo) {
      void api<NonNullable<typeof vault>>("/vault/status")
        .then(setVault)
        .catch(() => {});
      void api<{ files: { size: number }[] }>("/files")
        .then((listing: { files: { size: number }[] }) =>
          setBriefcase(listing.files.reduce((sum, f) => sum + f.size, 0)),
        )
        .catch(() => {});
    }
    void db.outbox.toArray().then(setPending);
    void db.meta.get("lastSync").then((x) => setLast(x?.value || ""));
  }, [items]);
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      if (file.name.endsWith(".csv")) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("El máximo es 10 MB.");
        setCSV(await file.text());
        return;
      }
      const data = await previewImport(file);
      const duplicates = data.filter((x) =>
        items.some(
          (i) =>
            i.id === x.id || (x.externalId && i.externalId === x.externalId),
        ),
      );
      setPreview(data.filter((x) => !duplicates.includes(x)));
      if (duplicates.length)
        notify(
          `${duplicates.length} elementos ya existen y se omitirán para conservar sus versiones.`,
        );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const trash = items.filter((i) => i.deleted && i.kind !== "note");
  const conflicts = pending.filter((p) => p.error);
  return (
    <>
      {confirmation}
      <PageHeading
        title={t("tools.settings")}
        description="Cómo funciona Second Brain en este dispositivo y dónde están tus datos."
      />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Secciones de ajustes">
          {sections.map(([key, label]) => (
            <button
              key={key}
              className={section === key ? "active" : ""}
              aria-current={section === key ? "page" : undefined}
              onClick={() => setParams({ seccion: key }, { replace: true })}
            >
              {label}
              {key === "datos" && conflicts.length > 0 && (
                <span className="unread-count">{conflicts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <section className="settings-panel">
          {section === "general" && (
            <>
              <SectionTitle title="Al usar la app" />
              <div className="setting-row">
                <div>
                  <h3>{t("lang.label")}</h3>
                  <p>{t("lang.note")}</p>
                </div>
                <select
                  aria-label={t("lang.label")}
                  value={getLang()}
                  onChange={(e) => setLang(e.target.value as Lang)}
                >
                  {LANGS.map((lang) => (
                    <option key={lang} value={lang}>
                      {t(`lang.${lang}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Abrir al iniciar</h3>
                  <p>
                    Entra directo a una herramienta si el mundo 3D va lento en
                    este equipo. La sala sigue a un clic.
                  </p>
                </div>
                <select
                  aria-label="Abrir al iniciar"
                  value={startView}
                  onChange={(e) => {
                    setStartView(e.target.value);
                    setPreference("startView", e.target.value);
                  }}
                >
                  <option value="/">Sala 3D</option>
                  <option value="/projects">Proyectos</option>
                  <option value="/tasks">Tareas</option>
                  <option value="/team">Equipo</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Calidad gráfica de la sala</h3>
                  <p>Se aplica la próxima vez que abras la app.</p>
                </div>
                <select
                  aria-label="Calidad gráfica de la sala"
                  value={quality}
                  onChange={(e) => {
                    setQuality(e.target.value);
                    store(QUALITY_KEY, e.target.value);
                  }}
                >
                  <option value="auto">Automática</option>
                  <option value="alta">Alta</option>
                  <option value="media">Media</option>
                  <option value="baja">Baja</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Horario de la agenda</h3>
                  <p>
                    Moneda: pesos mexicanos (MXN). Los eventos conservan su zona
                    de origen.
                  </p>
                </div>
                <select
                  aria-label="Horario de la agenda"
                  value={zone}
                  onChange={(e) => {
                    setZone(e.target.value);
                    store("sb-zone", e.target.value);
                    notify("Zona horaria actualizada.");
                  }}
                >
                  {zones.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <SectionTitle title="Privacidad" />
              <label className="setting-row setting-switch">
                <div>
                  <h3>Ocultar importes</h3>
                  <p>
                    Cubre cifras y gráficas de finanzas en este dispositivo,
                    también en los paneles de la sala.
                  </p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  checked={hideMoney}
                  onChange={(e) => {
                    setHideMoney(e.target.checked);
                    store("sb-hide-money", String(e.target.checked));
                    window.dispatchEvent(new Event("sb-money-visibility"));
                  }}
                />
              </label>
              <SectionTitle title="Atajos de teclado" />
              <dl className="settings-shortcuts">
                <div>
                  <dt>
                    <kbd>Ctrl</kbd> <kbd>K</kbd>
                  </dt>
                  <dd>Buscar en tu espacio</dd>
                </div>
                <div>
                  <dt>
                    <kbd>N</kbd>
                  </dt>
                  <dd>Crear con una frase (desde la sala)</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Esc</kbd>
                  </dt>
                  <dd>Cerrar la herramienta abierta</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Enter</kbd>
                  </dt>
                  <dd>Enviar mensaje a la agente</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Ctrl</kbd> <kbd>Enter</kbd>
                  </dt>
                  <dd>Insertar salto de línea en el mensaje</dd>
                </div>
              </dl>
            </>
          )}
          {section === "equipo" && (
            <>
              <SectionTitle title="Tu equipo" />
              <TeamSettings />
            </>
          )}
          {section === "datos" && (
            <>
              <SectionTitle title="Sincronización" />
              <div className="setting-row">
                <div>
                  <h3>
                    {isDemo
                      ? "Demo local"
                      : vault
                        ? "Conectado a tu Second Brain"
                        : "Comprobando conexión"}
                  </h3>
                  <p>
                    {isDemo
                      ? "Los ejemplos se guardan solo en este navegador."
                      : (last
                          ? "Última sincronización: " +
                            new Date(last).toLocaleString("es-MX")
                          : "Aún no hay una sincronización confirmada.") +
                        (pending.length
                          ? ` · ${pending.length} ${pending.length === 1 ? "cambio pendiente" : "cambios pendientes"}`
                          : "")}
                  </p>
                </div>
                {!isDemo && (
                  <button
                    className="button"
                    disabled={syncing}
                    onClick={() => {
                      setSyncing(true);
                      void Promise.resolve(sync())
                        .catch((e: Error) => notify(e.message))
                        .finally(() => setSyncing(false));
                    }}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    {syncing ? "Sincronizando…" : "Sincronizar"}
                  </button>
                )}
              </div>
              {vault?.issues.map((issue, i) => (
                <p key={i} className="form-error">
                  {issue.path}: {issue.message}
                </p>
              ))}
              {conflicts.map((p) => (
                <div className="conflict" key={p.id}>
                  <h3>{p.entity.title}</h3>
                  <p>{p.error}</p>
                  <div>
                    <button
                      className="button small"
                      onClick={() =>
                        void resolve(p.id, "copy").catch((e) =>
                          notify(e.message),
                        )
                      }
                    >
                      Conservar como copia
                    </button>
                    <button
                      className="button small"
                      onClick={() =>
                        void resolve(p.id, "server").catch((e) =>
                          notify(e.message),
                        )
                      }
                    >
                      Usar versión del servidor
                    </button>
                  </div>
                </div>
              ))}
              {pending.length > 0 && (
                <div className="setting-row">
                  <div>
                    <h3>Borradores sin sincronizar</h3>
                    <p>Guarda una copia antes de cambiar de dispositivo.</p>
                  </div>
                  <button
                    className="button"
                    onClick={() => exportAll(pending.map((p) => p.entity))}
                  >
                    <Download size={16} aria-hidden="true" />
                    Exportar
                  </button>
                </div>
              )}
              {!isDemo && (
                <>
                  <SectionTitle title="Maletín" />
                  <div className="setting-row">
                    <div>
                      <h3>
                        {briefcase === null
                          ? "Consultando espacio…"
                          : `${sizeLabel(briefcase)} de 2 GB en uso`}
                      </h3>
                      {briefcase !== null && (
                        <meter
                          className="settings-meter"
                          aria-label="Espacio usado del Maletín"
                          min={0}
                          max={BRIEFCASE_LIMIT}
                          value={briefcase}
                        />
                      )}
                      <p>
                        Los archivos sin fijar caducan a los 30 días, incluidas
                        las capturas del banco.
                      </p>
                    </div>
                    <Link className="button" to="/files">
                      Abrir Maletín
                    </Link>
                  </div>
                </>
              )}
              <SectionTitle title="Copias y archivos" />
              <div className="setting-row">
                <div>
                  <h3>Exportar mi espacio</h3>
                  <p>
                    Descarga tus datos originales en un archivo ZIP. No incluye
                    contraseñas ni sesiones.
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() =>
                    isDemo
                      ? exportAll(items)
                      : void exportVault().catch((e) => notify(e.message))
                  }
                >
                  <Download size={16} aria-hidden="true" />
                  Exportar
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <h3>Importar archivos</h3>
                  <p>
                    Trae datos de otro lugar: ZIP, Markdown, JSON, calendario
                    ICS o CSV del banco. Revisas antes de guardar.
                  </p>
                </div>
                <label className="button file-button">
                  <Upload size={16} aria-hidden="true" />
                  {busy ? "Leyendo…" : "Elegir archivo"}
                  <input
                    type="file"
                    accept=".zip,.md,.json,.ics,.csv"
                    disabled={busy}
                    onChange={(e) => {
                      void pick(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <SectionTitle title="Papelera" count={trash.length} />
              {trash.length ? (
                trash.map((i) => (
                  <div className="setting-row" key={i.id}>
                    <span>{i.title}</span>
                    <button
                      className="text-link"
                      onClick={() =>
                        void save({ ...i, deleted: false }).catch((e) =>
                          notify(e.message),
                        )
                      }
                    >
                      Restaurar
                    </button>
                  </div>
                ))
              ) : (
                <p className="muted">No hay elementos en la papelera.</p>
              )}
              {isDemo && (
                <div className="setting-row">
                  <div>
                    <h3>Restablecer ejemplos</h3>
                    <p>Vuelve a los datos originales de la demo.</p>
                  </div>
                  <button
                    className="button"
                    onClick={async () => {
                      if (
                        await confirm(
                          "¿Restablecer los datos de ejemplo de esta demo?",
                          { confirmLabel: "Restablecer", danger: true },
                        )
                      )
                        void resetDemo();
                    }}
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    Restablecer
                  </button>
                </div>
              )}
            </>
          )}
          {section === "seguridad" && (
            <>
              <SectionTitle title="Acceso" />
              {authEnabled ? (
                <>
                  <Security />
                  <McpClients />
                  {!isDemo && (
                    <div className="setting-row">
                      <div>
                        <h3>Cerrar sesión</h3>
                        <p>
                          Termina la sesión en este navegador. Los borradores
                          pendientes se conservan.
                        </p>
                      </div>
                      <button
                        className="button"
                        onClick={() =>
                          void logout().catch((e) => notify(e.message))
                        }
                      >
                        Cerrar sesión
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="muted">
                  Este entorno no usa inicio de sesión. El acceso lo protege el
                  servidor donde corre.
                </p>
              )}
            </>
          )}
          {section === "acerca" && (
            <>
              <SectionTitle title="Second Brain 0.2" />
              <p className="settings-note">
                {isDemo
                  ? "Datos de ejemplo. No representan tus finanzas ni compromisos reales."
                  : "Tus datos siguen en tu Second Brain. Este dispositivo guarda una copia para consultarla sin conexión."}
              </p>
              {vault && (
                <div className="setting-row">
                  <div>
                    <h3>{vault.documents} documentos en el vault</h3>
                    <p>
                      {vault.issues.length
                        ? `${vault.issues.length} por revisar en Datos.`
                        : "Sin problemas de formato."}
                    </p>
                  </div>
                </div>
              )}
              <div className="setting-row">
                <div>
                  <h3>Lo que todavía no existe</h3>
                  <p>
                    Notificaciones push y conexión bancaria. Por eso las
                    finanzas se actualizan a mano o con una agente.
                  </p>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <h3>¿Falta algo?</h3>
                  <p>Déjalo como tarea para no perder la idea.</p>
                </div>
                <button className="button" onClick={() => edit("task")}>
                  Anotar una mejora
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {csv !== null && <CSVImport text={csv} onClose={() => setCSV(null)} />}{" "}
      {preview && (
        <Modal
          title="Revisar importación"
          onClose={() => setPreview(null)}
          wide
        >
          <p className="muted">
            {preview.length} elementos nuevos. Los existentes se conservan. El
            origen no se modifica.
          </p>
          <div className="import-preview">
            {preview.slice(0, 100).map((x) => (
              <div key={x.id}>
                <span className="tag">{x.kind}</span>
                <span>{x.title}</span>
              </div>
            ))}
            {preview.length > 100 && <p>Y {preview.length - 100} más.</p>}
          </div>
          <div className="modal-actions">
            <button className="button subtle" onClick={() => setPreview(null)}>
              Cancelar
            </button>
            <button
              className="button primary"
              disabled={busy || !preview.length}
              onClick={async () => {
                setBusy(true);
                try {
                  await importItems(preview);
                  notify("Importación guardada.");
                  setPreview(null);
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "Importando…"
                : "Importar " + preview.length + " elementos"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
