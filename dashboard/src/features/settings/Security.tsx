import { useState } from "react";
import { ShieldCheck, KeyRound } from "lucide-react";
import { api, isDemo } from "../../core/store";
import { Modal, useUI } from "../../components/ui";
import { useConfirmation } from "../../components/useConfirmation";
export function Security() {
  const { notify } = useUI();
  const { confirm, confirmation } = useConfirmation();
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      {confirmation}
      <div className="setting-row">
        <div>
          <h3>Verificación en dos pasos</h3>
          <p>
            Añade un código temporal de tu app de autenticación para proteger el
            acceso.
          </p>
        </div>
        <button
          className="button"
          disabled={busy || isDemo}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await api<{ key: string }>("/auth/totp/start", {
                method: "POST",
                body: "{}",
              });
              setKey(result.key);
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ShieldCheck size={16} />
          Configurar
        </button>
      </div>
      {key && (
        <Modal
          title={codes ? "Códigos de recuperación" : "Protege tu espacio"}
          onClose={async () => {
            if (
              !codes ||
              (await confirm(
                "¿Ya guardaste los códigos de recuperación fuera del servidor?",
                { confirmLabel: "Ya los guardé" },
              ))
            ) {
              setKey("");
              setCodes(null);
            }
          }}
        >
          {codes ? (
            <>
              <p className="muted">
                Guarda estos códigos fuera del servidor. Cada uno se usa una
                sola vez en lugar del código de la app. No volverán a mostrarse.
              </p>
              <div className="recovery-codes">
                {codes.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </div>
              <button
                className="button primary"
                onClick={() => {
                  setKey("");
                  setCodes(null);
                  notify("Verificación en dos pasos activada.");
                }}
              >
                <KeyRound size={16} />
                Ya guardé mis códigos
              </button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const result = await api<{ codes: string[] }>(
                    "/auth/totp/enable",
                    {
                      method: "POST",
                      body: JSON.stringify({ password: "", code }),
                    },
                  );
                  setCodes(result.codes);
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p className="muted">
                En tu app de autenticación, añade una cuenta con clave manual de
                tipo «basada en tiempo» (TOTP).
              </p>
              <label className="field security-key">
                Clave de configuración
                <input
                  readOnly
                  value={key}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <label className="field">
                Código de seis dígitos
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={code}
                  required
                  pattern="[0-9]{6}"
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <button className="button primary" disabled={busy}>
                Verificar y activar
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
