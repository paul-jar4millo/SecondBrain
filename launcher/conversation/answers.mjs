import { validateAndExtractElicitationContent } from "../provider-adapters.mjs";
import { LauncherError } from "../errors.mjs";
import { canonicalStringify, expireRequest, validId } from "./persistence.mjs";

/** @import {ConversationAnswer, ConversationJob, ConversationReceipt, ConversationRequest, PendingConversationCallback} from "../provider-conversation-types.mjs" */
/** @import {ConversationRuntime} from "./controllers.mjs" */

/**
 * @param {ConversationRequest} request
 * @param {ConversationAnswer} answer
 */
function validateAnswer(request, { answers, decision, content }) {
  if (request.kind === "approval") {
    if (!decision || !request.choices?.includes(decision)) {
      throw new LauncherError("Decisión inválida.", 400);
    }
    if (
      decision === "accept" &&
      (request.requestedSchema !== undefined ||
        request.mode !== undefined ||
        content !== undefined)
    ) {
      validateAndExtractElicitationContent(
        request.requestedSchema,
        content,
        request.mode || "form",
      );
    }
  }
  if (
    request.kind === "question" &&
    (!answers ||
      typeof answers !== "object" ||
      Array.isArray(answers) ||
      (request.questions || []).some((q) => {
        const val = answers[q.id];
        if (Array.isArray(val)) return val.length === 0;
        return typeof val !== "string" || !val.trim();
      }))
  )
    throw new LauncherError("Completa todas las respuestas.", 400);
}

/**
 * Answers to provider requests (approvals and questions). An answer is stored
 * durably before it is handed to the provider's live callback, and its
 * receipt records how far delivery can be proven.
 * @param {Pick<ConversationRuntime, "persistence" | "running">} runtime
 */
export function createAnswerHandler({ persistence, running }) {
  const { change, pushEvent, settled } = persistence;

  /**
   * @param {string} id
   * @param {ConversationAnswer & { requestId: string, responseId: string }} input
   */
  return async function answer(
    id,
    { requestId, responseId, answers, decision, content },
  ) {
    if (!validId(requestId) || !validId(responseId))
      throw new LauncherError("Respuesta inválida.", 400);
    const store = await settled(id);
    const incomingAnswer = {
      ...(answers !== undefined ? { answers } : {}),
      ...(decision !== undefined ? { decision } : {}),
      ...(content !== undefined ? { content } : {}),
    };
    const receipt = store.state.receipts.find(
      (r) => r.responseId === responseId,
    );
    if (receipt) {
      if (
        receipt.requestId !== requestId ||
        canonicalStringify(receipt.answer) !==
          canonicalStringify(incomingAnswer)
      )
        throw new LauncherError("Conflicto de respuesta.", 409);
      return structuredClone(receipt);
    }
    const request = store.state.requests.find((r) => r.id === requestId);
    const liveJob = running.get(id);
    const callback = liveJob?.callbacks.get(requestId);
    if (
      !request ||
      request._claiming ||
      !callback ||
      callback.closed ||
      callback.turnId !== request.turnId ||
      callback.connectionId !== request.connectionId ||
      request.status !== "pending" ||
      request.nativeCallbackStatus !== "open"
    )
      throw new LauncherError("La solicitud ya no está vigente.", 409);
    // A callback is only found through its running job.
    const job = /** @type {ConversationJob} */ (liveJob);
    if (callback.isConnectionAlive && !callback.isConnectionAlive()) {
      callback.closed = true;
      job.callbacks.delete(requestId);
      await change(store, () => expireRequest(request, "interrupted")).catch(
        () => {},
      );
      throw new LauncherError(
        "La conexión con el proveedor cerró antes de enviar la respuesta.",
        409,
      );
    }
    validateAnswer(request, { answers, decision, content });

    // Step 1: Claim synchronously and persist answer durably ("respuesta_recibida") BEFORE dispatch.
    request._claiming = true;
    /** @type {ConversationReceipt} */
    const result = {
      requestId,
      responseId,
      turnId: request.turnId ?? null,
      connectionId: callback.connectionId ?? null,
      answer: structuredClone(incomingAnswer),
      status: "respuesta_recibida",
      delivered: false,
      transportEvidence: null,
    };
    request.status = "answered";
    request.nativeCallbackStatus = "responded";
    if (request.kind === "question") {
      request.productStatus = "respuesta_recibida";
    }
    try {
      await change(store, (state) => {
        state.receipts.push(result);
        request.answer = structuredClone(incomingAnswer);
        pushEvent(state, id, {
          type:
            request.kind === "approval"
              ? "approval.resolved"
              : "user_request.resolved",
          turnId: request.turnId ?? null,
          correlationId: requestId,
          sourceId: "app",
          payload: structuredClone(result),
        });
      });
    } catch (error) {
      request.status = "pending";
      request.nativeCallbackStatus = "open";
      if (request.kind === "question") request.productStatus = "pendiente";
      store.state.receipts = store.state.receipts.filter((r) => r !== result);
      delete request.answer;
      delete request._claiming;
      throw error;
    }
    delete request._claiming;

    /** @param {ConversationReceipt["status"]} status */
    const setStatus = (status) => {
      result.status = status;
      if (request.kind === "question") request.productStatus = status;
    };
    /**
     * Applies a delivery outcome and publishes it as an event.
     * @param {() => void} apply
     */
    const recordDelivery = (apply) =>
      change(store, (state) => {
        apply();
        pushEvent(state, id, {
          type: "user_request.delivery",
          turnId: request.turnId ?? null,
          correlationId: requestId,
          sourceId: "provider",
          payload: structuredClone(result),
        });
      });

    // Step 2: Transition to "entregando" and dispatch to live protocol callback
    await change(store, () => setStatus("entregando"));

    job.callbacks.delete(requestId);
    /** @type {Parameters<PendingConversationCallback["resolve"]>[0]} */
    const replyPayload =
      request.kind === "question"
        ? /** @type {any} */ (answers)
        : {
            decision,
            ...(content !== undefined
              ? { content: structuredClone(content) }
              : {}),
          };
    callback.resolve(replyPayload);

    // Step 3: Verify transport flush (without assuming harness consumption until progress)
    if (callback.writeAck) {
      try {
        await callback.writeAck;
        job.markDeliveredPendingConfirmation?.();
        await recordDelivery(() => {
          setStatus("entregada");
          result.delivered = true;
          result.transportObservable = true;
          result.transportEvidence = "rpc_write_flushed";
        });
      } catch (writeErr) {
        await recordDelivery(() => {
          setStatus("entrega_incierta");
          result.delivered = false;
          result.transportObservable = true;
          result.transportEvidence = null;
          result.error =
            writeErr?.message ||
            "Conexión caída o error enviando respuesta al proveedor.";
          request.nativeCallbackStatus = "interrupted";
        });
      }
    } else if (callback.transportMode === "sdk_callback_return") {
      try {
        await callback.callbackAck;
        job.markDeliveredPendingConfirmation?.();
        await recordDelivery(() => {
          // Claude SDK callbacks return a Promise to the SDK without an OS pipe write-flush ack.
          setStatus("entregando");
          result.callbackReturned = true;
          result.delivered = false;
          result.transportObservable = false;
          result.transportMode = "sdk_callback_return";
          result.transportEvidence = "callback_returned";
          result.transportLimit =
            "El SDK de Claude no expone acuse de escritura en transporte; pendiente de progreso posterior del agente.";
        });
      } catch (sdkErr) {
        await recordDelivery(() => {
          setStatus("entrega_incierta");
          result.callbackReturned = false;
          result.delivered = false;
          result.transportObservable = false;
          result.transportMode = "sdk_callback_return";
          result.transportEvidence = null;
          result.error =
            sdkErr?.message ||
            "La sesión del SDK de Claude se cerró antes de confirmar la devolución del callback.";
          request.nativeCallbackStatus = "interrupted";
        });
      }
    } else {
      job.markDeliveredPendingConfirmation?.();
      await change(store, () => {
        setStatus("entregada");
        result.delivered = true;
        result.transportEvidence = "callback_resolved";
      });
    }
    return structuredClone(result);
  };
}
