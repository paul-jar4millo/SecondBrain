import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { useLang } from "./core/i18n";
import { reloadForNewVersion } from "./core/recovery";
import "./styles/style.css";
import "./styles/quick-views.css";
import "./styles/refugio.css";
import "./styles/assist.css";
import "./styles/tools.css";
import "./styles/workspaces.css";
/** Remounts the app when the language changes, so every t() call refreshes. */
function LocalizedApp() {
  const lang = useLang();
  return <App key={lang} />;
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocalizedApp />
  </React.StrictMode>,
);
// Vite fires this when a lazy chunk from an older deploy is gone from the server.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});
// The static demo has no offline mode: it must never cache a stale build.
if (
  import.meta.env.PROD &&
  import.meta.env.VITE_DEMO !== "1" &&
  "serviceWorker" in navigator
) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
