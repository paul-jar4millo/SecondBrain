import { Component, type ReactNode } from "react";
import { isStaleChunk, reloadForNewVersion } from "../core/recovery";

/** A render error would otherwise leave a blank page with no way back. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
    if (isStaleChunk(error)) reloadForNewVersion();
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth-page">
        <main className="auth-main" role="alert">
          <h1>Algo falló al mostrar esta pantalla</h1>
          <p className="muted">
            Tus notas y cambios pendientes están guardados en este dispositivo.
            Recargar suele resolverlo.
          </p>
          <p className="muted">{this.state.error.message}</p>
          <button
            type="button"
            className="button primary"
            onClick={() => location.reload()}
          >
            Recargar
          </button>
        </main>
      </div>
    );
  }
}
