// Idempotent answers to approvals: one requestId per click, reused by every
// retry, and the receipt the service stores next to the decision.

export interface Receipt {
  requestId: string;
  aprobacionId: string;
  decision: "aprobada" | "rechazada";
  por: string;
  ts: number;
  resultado: string;
}

/** randomUUID only exists in secure contexts; the dashboard may be served over plain HTTP on the LAN. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A network failure, a timeout or a gateway error: the request may not have arrived. */
export function isTransient(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  return status === undefined || [502, 503, 504].includes(status);
}

/**
 * Sends with a fresh requestId and, on a transient failure, again with the same
 * one (up to `retries` times): the service answers the stored receipt instead of
 * applying the decision twice.
 */
export async function sendWithRetry<T>(
  send: (requestId: string) => Promise<T>,
  {
    retries = 3,
    wait = (attempt: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, 400 * attempt)),
    requestId = newRequestId(),
  }: {
    retries?: number;
    wait?: (attempt: number) => Promise<void>;
    requestId?: string;
  } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(requestId);
    } catch (error) {
      if (attempt >= retries || !isTransient(error)) throw error;
      await wait(attempt + 1);
    }
  }
}

export function describeReceipt(receipt: Receipt) {
  const who = receipt.por === "app" ? "ti" : receipt.por;
  const time = new Date(receipt.ts).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${receipt.decision === "aprobada" ? "Aprobado" : "Rechazado"} por ${who} a las ${time}`;
}
