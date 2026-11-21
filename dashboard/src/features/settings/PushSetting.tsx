// Web push opt-in (phase C2): this device receives a notice when a thread
// needs the owner. The subscription lives in the browser and the service.
import { useEffect, useState } from "react";
import { api, isDemo } from "../../core/store";

const supported = () =>
  !isDemo &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export function PushSetting() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!supported()) return;
    let alive = true;
    void currentSubscription()
      .then((subscription) => alive && setEnabled(Boolean(subscription)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!supported()) return null;

  const turnOn = async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setMessage(
        "El navegador bloqueó los avisos; permítelos en los ajustes del sitio.",
      );
      return;
    }
    const { publicKey } = await api<{ publicKey: string }>("/push/key");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
    await api("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
    setEnabled(true);
    setMessage("Este dispositivo recibirá avisos.");
  };

  const turnOff = async () => {
    const subscription = await currentSubscription();
    if (subscription) {
      await api("/push/subscriptions/remove", {
        method: "POST",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined);
      await subscription.unsubscribe();
    }
    setEnabled(false);
    setMessage("");
  };

  return (
    <label className="setting-row setting-switch">
      <div>
        <h3>Avisos en este dispositivo</h3>
        <p>
          Una notificación cuando un thread te pregunta algo, necesita tu
          decisión, está listo para revisar, falla o pasa de etapa.
        </p>
        {message && <p role="status">{message}</p>}
      </div>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        disabled={busy}
        onChange={(event) => {
          const on = event.target.checked;
          setBusy(true);
          setMessage("");
          void (on ? turnOn() : turnOff())
            .catch(() => setMessage("No se pudo cambiar; vuelve a intentarlo."))
            .finally(() => setBusy(false));
        }}
      />
    </label>
  );
}
