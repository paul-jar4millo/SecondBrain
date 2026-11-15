import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeChanges } from "../../core/events";
import { isDemo } from "../../core/store";
import { teamApi } from "./team-store";
import { ApprovalQueue, type Approval } from "./ApprovalQueue";
import {
  describeReceipt,
  sendWithRetry,
  type Receipt,
} from "./approval-receipts";

const RECENT_MS = 60 * 60_000;

export function ApprovalPanel({ hideEmpty = false }: { hideEmpty?: boolean }) {
  const [solicitudes, setSolicitudes] = useState<Approval[] | null>(null);
  const [error, setError] = useState("");
  const [last, setLast] = useState<Receipt | null>(null);
  const [recent, setRecent] = useState<Receipt[]>([]);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const actual = ++revision.current;
    try {
      const lista = isDemo
        ? []
        : ((await teamApi("/aprobaciones")) as Approval[]);
      if (actual === revision.current) {
        setSolicitudes(lista);
        setRecent(
          lista
            .filter(
              (s) => s.recibo && (s.resuelta ?? 0) > Date.now() - RECENT_MS,
            )
            .sort((a, b) => (b.resuelta ?? 0) - (a.resuelta ?? 0))
            .slice(0, 3)
            .map((s) => s.recibo as Receipt),
        );
        setError("");
      }
    } catch {
      if (actual === revision.current)
        setError(
          "No se pudieron consultar las aprobaciones. Vuelve a intentarlo.",
        );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const dejar = subscribeChanges(() => void refresh());
    const contador = revision;
    return () => {
      contador.current++;
      dejar();
    };
  }, [refresh]);
  async function decidir(id: string, aprobar: boolean) {
    try {
      // One id per click; a lost answer is retried with the same one.
      const answer = (await sendWithRetry((requestId) =>
        teamApi("/aprobaciones/decidir", { id, aprobar, requestId }),
      )) as { recibo?: Receipt };
      if (answer?.recibo) setLast(answer.recibo);
    } catch (caught) {
      const receipt = (caught as { recibo?: Receipt }).recibo;
      if (receipt) {
        setLast(receipt);
        await refresh();
        throw new Error(`Ya estaba resuelta: ${describeReceipt(receipt)}.`);
      }
      throw caught;
    }
    await refresh();
  }
  return (
    <>
      {error && (
        <p className="inline-error" role="alert">
          {error}{" "}
          <button className="button" onClick={() => void refresh()}>
            Reintentar
          </button>
        </p>
      )}
      {solicitudes && (
        <ApprovalQueue solicitudes={solicitudes} onDecision={decidir} />
      )}
      {last && (
        <p className="approval-receipt" role="status">
          {describeReceipt(last)}.
        </p>
      )}
      {recent
        .filter((r) => r.requestId !== last?.requestId)
        .map((r) => (
          <p className="approval-receipt muted" key={r.requestId}>
            {describeReceipt(r)}.
          </p>
        ))}
      {!hideEmpty &&
        solicitudes &&
        !solicitudes.some((s) => s.estado === "pendiente") && (
          <p className="muted">No hay solicitudes pendientes.</p>
        )}
    </>
  );
}
