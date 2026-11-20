// Mirrors a launcher session's event stream into the work order it serves:
// questions and approvals become user requests, the rest become events.

/**
 * @param {{
 *   lanzador: ReturnType<typeof import("./launcher-client.mjs").createLanzador>,
 *   userRequests: Awaited<ReturnType<typeof import("./user-requests.mjs").createUserRequestStore>>,
 *   workOrders: Awaited<ReturnType<typeof import("./work-orders.mjs").createWorkOrderStore>>,
 * }} deps
 */
export function createSessionBridges({ lanzador, userRequests, workOrders }) {
  /** @type {Map<string, AbortController>} */
  const activeSessionBridges = new Map();
  /** @type {Map<string, { workOrderId: string, fallbackMemberId?: string | null }>} */
  const sessionWorkOrderLinks = new Map();
  /**
   * Sessions that received a message while their bridge was open.
   * @type {Set<string>}
   */
  const followUpTurns = new Set();
  let closed = false;
  /**
   * @param {string} sessionId
   * @param {string} workOrderId
   * @param {string | null} [fallbackMemberId]
   */
  const bridgeSessionToWorkOrder = (
    sessionId,
    workOrderId,
    fallbackMemberId,
  ) => {
    if (!sessionId || !workOrderId) return;
    sessionWorkOrderLinks.set(sessionId, { workOrderId, fallbackMemberId });
    if (activeSessionBridges.has(sessionId)) {
      // A message sent during a turn starts another one when it ends: the
      // open bridge must outlive the first "terminada" to record it.
      followUpTurns.add(sessionId);
      return;
    }
    const controller = new AbortController();
    activeSessionBridges.set(sessionId, controller);
    const seen = new Set();
    /** @type {NodeJS.Timeout | null} */
    let awaitingTurn = null;
    void (async () => {
      try {
        const upstream = await lanzador.flujo(
          sessionId,
          controller.signal,
          true,
        );
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body ?? []) {
          if (controller.signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            let state;
            try {
              state = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            for (const ev of state.events || []) {
              if (!ev?.id || seen.has(ev.id)) continue;
              seen.add(ev.id);
              if (
                ev.type === "user_request.created" ||
                ev.type === "approval.created"
              ) {
                const req = ev.payload || {};
                const qOpts = Array.isArray(req.questions?.[0]?.options)
                  ? req.questions[0].options.map(
                      /** @param {string | { label?: string }} o */
                      (o) => (typeof o === "string" ? o : o.label || String(o)),
                    )
                  : req.choices || [];
                await userRequests
                  .createRequest({
                    id: req.id,
                    createRequestId: req.id,
                    kind: req.kind === "approval" ? "approval" : "question",
                    workOrderId,
                    sessionId,
                    memberId: fallbackMemberId || ev.sourceId,
                    title: req.title,
                    prompt:
                      req.questions?.[0]?.question ||
                      req.detail ||
                      req.title ||
                      "Solicitud",
                    options: qOpts,
                    nativeRequestId: req.nativeId,
                    nativeTurnId: ev.turnId,
                  })
                  .catch(() => {});
              } else {
                await workOrders
                  .appendEvent(workOrderId, {
                    id: ev.id,
                    idempotencyKey: `lz:${ev.id}`,
                    sourceId: fallbackMemberId || ev.sourceId,
                    sessionId,
                    turnId: ev.turnId,
                    nativeItemId: ev.nativeItemId,
                    correlationId: ev.correlationId,
                    provenance: "observed",
                    type: ev.type,
                    payload: ev.payload,
                  })
                  .catch(() => {});
                if (
                  ev.type === "turn.completed" ||
                  ev.type === "turn.interrupted"
                ) {
                  await userRequests
                    .markTurnClosed({
                      sessionId,
                      nativeTurnId: ev.turnId,
                      reason:
                        ev.type === "turn.interrupted"
                          ? "interrupted"
                          : "closed_by_turn",
                    })
                    .catch(() => {});
                }
              }
            }
            if (
              !["terminada", "cancelada", "interrumpida", "error"].includes(
                state.status,
              )
            ) {
              clearTimeout(awaitingTurn ?? undefined);
              awaitingTurn = null;
            } else if (followUpTurns.delete(sessionId)) {
              // Give the queued message time to start; a cancelled one
              // never does.
              awaitingTurn = setTimeout(() => controller.abort(), 60_000);
              awaitingTurn.unref?.();
            } else if (!awaitingTurn) {
              controller.abort();
              break;
            }
          }
        }
      } catch {
        /* Bridge terminates silently when stream closes or is aborted. */
      } finally {
        clearTimeout(awaitingTurn ?? undefined);
        activeSessionBridges.delete(sessionId);
        // A message that arrived while this bridge was closing.
        if (followUpTurns.delete(sessionId) && !closed)
          bridgeSessionToWorkOrder(sessionId, workOrderId, fallbackMemberId);
      }
    })();
  };
  return {
    bridge: bridgeSessionToWorkOrder,
    /** @param {string} sessionId */
    linkOf: (sessionId) => sessionWorkOrderLinks.get(sessionId),
    close() {
      closed = true;
      followUpTurns.clear();
      for (const c of activeSessionBridges.values()) c.abort();
      activeSessionBridges.clear();
    },
  };
}
