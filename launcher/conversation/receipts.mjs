/** @import {ConversationReceipt, ConversationState} from "../provider-conversation-types.mjs" */
/** @import {ConversationPersistence} from "./persistence.mjs" */

/**
 * The turn whose receipts are being settled.
 * @typedef {{
 *   sessionId: string,
 *   turnId: string,
 *   connectionId: string,
 *   pushEvent: ConversationPersistence["pushEvent"]
 * }} ReceiptTurn
 */

/**
 * Delivered but not yet confirmed: the transport took the answer, or the SDK
 * callback returned, and the provider has not shown progress since.
 * @param {ConversationReceipt} r
 */
const awaitingConfirmation = (r) =>
  r.status === "entregada" ||
  (r.status === "entregando" && r.callbackReturned === true);

/**
 * @param {ConversationReceipt} r
 * @param {ReceiptTurn} turn
 */
const belongsTo = (r, { turnId, connectionId }) =>
  r.turnId === turnId && (!r.connectionId || r.connectionId === connectionId);

/**
 * @param {ConversationState} state
 * @param {ReceiptTurn} turn
 * @param {ConversationReceipt} r
 */
function publishDelivery(state, turn, r) {
  turn.pushEvent(state, turn.sessionId, {
    type: "user_request.delivery",
    turnId: turn.turnId,
    correlationId: r.requestId,
    sourceId: "provider",
    payload: structuredClone(r),
  });
}

/**
 * Progress from the provider proves it consumed the answers delivered in this
 * turn: mark them confirmed.
 * @param {ConversationState} state
 * @param {ReceiptTurn} turn
 * @returns {boolean} whether receipts from other turns still wait for progress
 */
export function promoteDeliveredReceipts(state, turn) {
  let stillPending = false;
  const now = new Date().toISOString();
  for (const r of state.receipts) {
    if (!awaitingConfirmation(r)) continue;
    if (!belongsTo(r, turn)) {
      stillPending = true;
      continue;
    }
    r.status = "confirmada";
    r.delivered = true;
    r.harnessConfirmedAt = now;
    if (r.transportMode === "sdk_callback_return") {
      r.transportEvidence = "harness_progress";
    }
    const req = state.requests.find((x) => x.id === r.requestId);
    if (req && req.kind === "question") {
      req.productStatus = "confirmada";
    }
    publishDelivery(state, turn, r);
  }
  return stillPending;
}

/**
 * The turn ended without the provider confirming the answers it was given:
 * their delivery is uncertain.
 * @param {ConversationState} state
 * @param {ReceiptTurn} turn
 * @param {string} reasonMessage
 */
export function reconcileUnconfirmedCallbacks(state, turn, reasonMessage) {
  for (const r of state.receipts) {
    if (
      belongsTo(r, turn) &&
      (r.status === "entregando" ||
        (r.status === "entregada" && !r.harnessConfirmedAt))
    ) {
      r.status = "entrega_incierta";
      r.delivered = false;
      r.error =
        r.error ||
        reasonMessage ||
        "El turno terminó sin confirmar recepción en el proveedor.";
      const req = state.requests.find((x) => x.id === r.requestId);
      if (req && req.kind === "question") {
        req.productStatus = "entrega_incierta";
      }
      publishDelivery(state, turn, r);
    }
  }
}
