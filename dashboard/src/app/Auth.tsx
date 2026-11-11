import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  db,
  api,
  resetCsrf,
  setAuthEnabled,
  setOwnerName,
} from "../core/store";
import { t } from "../core/i18n";
export function Auth({
  onAuthenticated,
  expired = false,
}: {
  onAuthenticated: () => void;
  /** Shown over open work: the cached copy must not let anyone back in. */
  expired?: boolean;
}) {
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [requiresCode, setRequiresCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/v1/auth/status")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(async (data) => {
        setAuthEnabled(data.enabled !== false);
        setOwnerName(data.ownerName);
        if (data.authenticated) {
          await db.meta.put({ key: "authorized", value: "yes" });
          onAuthenticated();
        } else {
          await db.meta.delete("authorized");
          setNeedsSetup(data.needsSetup);
          setChecking(false);
        }
      })
      .catch(async () => {
        if (!expired && (await db.meta.get("authorized"))?.value === "yes") {
          onAuthenticated();
        } else {
          setError(t("auth.offline"));
          setChecking(false);
        }
      });
  }, [onAuthenticated, expired]);
  // Over open work there is already a <main>; a second one would confuse screen readers.
  const Main = expired ? "section" : "main";
  return (
    <div
      className={expired ? "auth-page auth-over" : "auth-page"}
      {...(expired
        ? {
            role: "dialog",
            "aria-modal": true,
            "aria-labelledby": "auth-title",
          }
        : {})}
    >
      <Main className="auth-main">
        <h1 id="auth-title">{t("app.name")}</h1>
        {expired && <p className="muted">{t("auth.expired")}</p>}
        {checking ? (
          <div className="muted">
            <LoaderCircle className="spin" size={18} /> {t("auth.opening")}
          </div>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const result = await api<{ requiresCode?: boolean }>(
                  needsSetup ? "/auth/setup" : "/auth/login",
                  {
                    method: "POST",
                    body: JSON.stringify({ username, password, code }),
                  },
                );
                if (result.requiresCode) {
                  setRequiresCode(true);
                  return;
                }
                resetCsrf();
                await db.meta.put({ key: "authorized", value: "yes" });
                onAuthenticated();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>{needsSetup ? t("auth.createUser") : t("auth.signIn")}</h2>
            <label className="field">
              {t("auth.username")}
              <input
                required
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={64}
                pattern={"[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,63}"}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="field">
              {needsSetup ? t("auth.newPassword") : t("auth.password")}
              <input
                type="password"
                name="password"
                required
                minLength={needsSetup ? 12 : 1}
                autoComplete={needsSetup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {requiresCode && (
              <label className="field">
                {t("auth.code")}
                <input
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="button primary auth-submit" disabled={busy}>
              {busy
                ? t("auth.opening")
                : needsSetup
                  ? t("auth.createUser")
                  : t("auth.signIn")}
            </button>
          </form>
        )}
        {!expired && (
          <a href="/?demo=1" className="demo-link">
            {t("auth.demo")}
          </a>
        )}
      </Main>
    </div>
  );
}
