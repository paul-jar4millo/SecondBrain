import { useEffect, useRef } from "react";
import { PageHeading } from "../../components/PageHeading";
import { api, isDemo } from "../../core/store";
import { montarPanel } from "./panel";
import { useConfirmation } from "../../components/useConfirmation";
import "./panel.css";

const apiPanel = (path: string, body?: unknown) =>
  api(path, body ? { method: "POST", body: JSON.stringify(body) } : undefined);

export default function WorldPage() {
  const { confirm, confirmation } = useConfirmation();
  const raiz = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isDemo) return montarPanel(raiz.current!, { api: apiPanel, confirm });
  }, [confirm]);
  return (
    <>
      {confirmation}
      <PageHeading
        title="Mundo Hipotético"
        description="Videos, métricas y agentes del canal."
      />
      {isDemo ? (
        <p>La demo no incluye los archivos del canal.</p>
      ) : (
        <div ref={raiz} className="mundo-panel">
          <div className="mundo-nav">
            <nav id="nav" aria-label="Secciones del proyecto" />
            <a
              href="/projects/mundo-hipotetico?view=settings"
              className="nav-link"
              id="settings-link"
            />
          </div>
          <div className="mundo-barra">
            <div className="breadcrumb">
              <strong id="breadcrumb">Vista general</strong>
            </div>
            <div className="header-actions">
              <label className="search">
                <span id="search-icon" aria-hidden="true" />
                <input
                  id="search"
                  name="search"
                  type="search"
                  placeholder="Buscar un video…"
                  autoComplete="off"
                  aria-label="Buscar videos"
                />
                <kbd>/</kbd>
              </label>
              <button
                className="icon-button"
                id="refresh"
                aria-label="Actualizar archivos del panel"
                title="Actualizar archivos"
              />
              <button className="button primary" id="new-video" />
            </div>
          </div>
          <div id="main" tabIndex={-1}>
            <div className="loading">Cargando el proyecto…</div>
          </div>
          <footer className="footer">
            <span>Mundo Hipotético</span>
            <span id="sync-label">Conectando con los archivos…</span>
          </footer>
          <dialog id="dialog" aria-labelledby="dialog-title">
            <div id="dialog-body" />
          </dialog>
          <div id="toast" role="status" aria-live="polite" />
        </div>
      )}
    </>
  );
}
