import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { isDemo, onSessionExpired, sync } from "../core/store";
import { t } from "../core/i18n";
import { Auth } from "./Auth";
import { ErrorBoundary } from "./ErrorBoundary";
import { Workspace } from "./Workspace";
export default function App() {
  const [authenticated, setAuthenticated] = useState(isDemo);
  // Kept apart from `authenticated` so an expired session does not unmount open work.
  const [expired, setExpired] = useState(false);
  const onAuthenticated = useState(() => () => {
    setAuthenticated(true);
    setExpired(false);
    // Drafts held back by the expired session go out now; a running sync ignores it.
    if (!isDemo) void sync();
  })[0];
  useEffect(() => onSessionExpired(() => setExpired(true)), []);
  return (
    <ErrorBoundary>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <a className="skip-link" href="#main-content">
          {t("app.skipToContent")}
        </a>
        {authenticated && (
          <Routes>
            <Route path="*" element={<Workspace />} />
          </Routes>
        )}
        {(!authenticated || expired) && (
          <Auth
            onAuthenticated={onAuthenticated}
            expired={authenticated && expired}
          />
        )}
      </BrowserRouter>
    </ErrorBoundary>
  );
}
