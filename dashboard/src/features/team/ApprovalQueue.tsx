import { useEffect, useState } from "react";

import type { Receipt } from "./approval-receipts";

export interface Approval {
  id: string;
  actor: string;
  estado: string;
  vence: number;
  resuelta?: number;
  recibo?: Receipt;
  operacion: Record<string, unknown>;
}

const etiquetas: Record<string, string> = {
  op: "Operación",
  amount: "Importe",
  card: "Tarjeta",
  name: "Nombre",
  desc: "Descripción",
  date: "Fecha",
  limit: "Límite",
  balance: "Saldo",
  pay: "Pago",
  dueDate: "Fecha límite",
  cutDate: "Fecha de corte",
  requestId: "Identificador",
  last4: "Últimos cuatro dígitos",
  note: "Nota",
};
const operations: Record<string, string> = {
  init: "Crear datos financieros",
  charge: "Registrar cargo",
  payment: "Registrar pago",
  "card-add": "Añadir tarjeta",
  "card-set": "Actualizar tarjeta",
  "tx-edit": "Editar movimiento",
  "tx-delete": "Eliminar movimiento",
};

export function ApprovalQueue({
  solicitudes: requests,
  onDecision,
}: {
  solicitudes: Approval[];
  onDecision: (id: string, approve: boolean) => Promise<void>;
}) {
  const [revisada, setRevisada] = useState<Record<string, boolean>>({});
  const [ocupada, setOcupada] = useState("");
  const [error, setError] = useState("");
  const [ahora, setNow] = useState(Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  const pending = requests.filter((s) => s.estado === "pendiente");
  if (!pending.length) return null;
  const decide = async (id: string, approve: boolean) => {
    setOcupada(id);
    setError("");
    try {
      await onDecision(id, approve);
    } catch (caught) {
      setError((caught as Error).message || "No se pudo guardar la decisión.");
    } finally {
      setOcupada("");
    }
  };
  return (
    <section className="approval-queue" aria-labelledby="approval-heading">
      <h2 id="approval-heading">Solicitudes de aprobación</h2>
      <p>Las agentes esperan tu decisión antes de cambiar las finanzas.</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {pending.map((s) => {
          const seconds = Math.max(0, Math.ceil((s.vence - ahora) / 1000));
          const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          return (
            <li key={s.id}>
              <div className="section-heading">
                <strong>
                  {s.actor.replace("agente:", "")} solicita una operación
                </strong>
                <span>{seconds ? `Vence en ${time}` : "Tiempo agotado"}</span>
              </div>
              <button
                className="button"
                type="button"
                onClick={() =>
                  setRevisada((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                }
              >
                {revisada[s.id] ? "Ocultar operación" : "Revisar operación"}
              </button>
              {revisada[s.id] && (
                <dl className="approval-details">
                  {Object.entries(s.operacion).map(([key, value]) => (
                    <div key={key}>
                      <dt>{etiquetas[key] || key}</dt>
                      <dd>
                        {key === "op" && typeof value === "string"
                          ? operations[value] || value
                          : typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="approval-actions">
                <button
                  className="button primary"
                  type="button"
                  disabled={!revisada[s.id] || !seconds || !!ocupada}
                  onClick={() => void decide(s.id, true)}
                >
                  Aprobar
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={!seconds || !!ocupada}
                  onClick={() => void decide(s.id, false)}
                >
                  Rechazar
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
