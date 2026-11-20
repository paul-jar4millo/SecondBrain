import { randomUUID } from "node:crypto";
import { LauncherError } from "../errors.mjs";
import { MESSAGE_DELIVERY_STATUSES } from "./persistence.mjs";

/** @import {ConversationCommand, ConversationState, MessageDeliveryStatus, QueuedConversationMessage, SendConversationMessageOptions} from "../provider-conversation-types.mjs" */
/** @import {ConversationRuntime} from "./controllers.mjs" */

/**
 * Messages the user sends to a session: delivered now, steered into the
 * running turn, or queued until it ends.
 * @param {Pick<ConversationRuntime, "persistence" | "running">} runtime
 */
export function createMessageQueue({ persistence, running }) {
  const { change, pushEvent, settled } = persistence;

  /**
   * @param {string} id
   * @param {SendConversationMessageOptions} [options]
   */
  async function sendMessage(
    id,
    {
      clientMessageId,
      text = "",
      mode = "send",
      attachments = [],
      online = true,
      // The caller still holds the session: a turn this layer has already
      // finished must not leave the message accepted but never delivered.
      queueIfIdle = false,
    } = {},
  ) {
    if (!clientMessageId || typeof clientMessageId !== "string") {
      throw new LauncherError("clientMessageId inválido.", 400);
    }
    if (!["send", "steer", "queue"].includes(mode)) {
      throw new LauncherError("Modo de envío inválido.", 400);
    }
    if (!String(text || "").trim() && attachments.length === 0) {
      throw new LauncherError("El mensaje no puede estar vacío.", 400);
    }
    const store = await settled(id);
    const existing = store.state.commands.find(
      (c) => c.clientMessageId === clientMessageId,
    );
    if (existing) {
      return {
        command: structuredClone(existing),
        repetido: true,
        queued: existing.deliveryStatus === "en_cola",
      };
    }

    const now = new Date().toISOString();
    /** @type {ConversationCommand} */
    const command = {
      id: randomUUID(),
      clientMessageId,
      mode: /** @type {ConversationCommand["mode"]} */ (mode),
      text: String(text || "").trim(),
      attachments: structuredClone(attachments),
      deliveryStatus: "recibido",
      turnId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const currentCommand = () =>
      structuredClone(store.state.commands.find((c) => c.id === command.id));

    const job = running.get(id);
    if (
      !online ||
      (!job && queueIfIdle) ||
      (job &&
        (mode === "queue" || mode === "send" || !job.control?.supportsSteer))
    ) {
      command.deliveryStatus = "en_cola";
      /** @type {QueuedConversationMessage} */
      const queueItem = {
        commandId: command.id,
        clientMessageId: command.clientMessageId,
        text: command.text,
        attachments: command.attachments,
        deliveryStatus: "en_cola",
        createdAt: now,
      };
      await change(store, (state) => {
        state.commands.push(command);
        state.queue.push(queueItem);
        pushEvent(state, id, {
          type: "message.queued",
          correlationId: command.id,
          sourceId: "app",
          payload: {
            commandId: command.id,
            clientMessageId,
            deliveryStatus: "en_cola",
            requestedMode: mode,
            fallbackToQueue: mode === "steer",
          },
        });
      });
      return {
        command: structuredClone(command),
        modo: "queue",
        queued: true,
        repetido: false,
      };
    }

    if (job && mode === "steer" && job.control?.supportsSteer) {
      command.turnId = job.turnId;
      await change(store, (state) => {
        state.commands.push(command);
        pushEvent(state, id, {
          type: "message.accepted",
          turnId: job.turnId,
          correlationId: command.id,
          sourceId: "app",
          payload: {
            commandId: command.id,
            clientMessageId,
            deliveryStatus: "recibido",
            mode: "steer",
          },
        });
      });
      /** @param {ConversationState} state */
      const pushedCommand = (state) =>
        // The command was pushed by the change above.
        /** @type {ConversationCommand} */ (
          state.commands.find((c) => c.id === command.id)
        );
      try {
        // supportsSteer is only advertised together with steer().
        if (!job.control.steer)
          throw new Error("El proveedor no admite redirección.");
        await job.control.steer(command.text, command.attachments);
        await change(store, (state) => {
          const target = pushedCommand(state);
          target.deliveryStatus = "confirmado_proveedor";
          target.updatedAt = new Date().toISOString();
          state.items.push({
            id: randomUUID(),
            tipo: "usuario",
            texto: command.text,
            mode: "steer",
            ts: target.updatedAt,
          });
        });
      } catch (err) {
        await change(store, (state) => {
          const target = pushedCommand(state);
          target.deliveryStatus = "entrega_incierta";
          target.error = err?.message || "Fallo al confirmar redirección";
          target.updatedAt = new Date().toISOString();
        });
      }
      return {
        command: currentCommand(),
        modo: "steer",
        queued: false,
        repetido: false,
      };
    }

    await change(store, (state) => {
      state.commands.push(command);
      pushEvent(state, id, {
        type: "message.accepted",
        correlationId: command.id,
        sourceId: "app",
        payload: {
          commandId: command.id,
          clientMessageId,
          deliveryStatus: "recibido",
          mode,
        },
      });
    });
    return {
      command: structuredClone(command),
      modo: mode,
      queued: false,
      repetido: false,
    };
  }

  /**
   * @param {string} id
   * @param {string} commandId
   * @param {MessageDeliveryStatus} deliveryStatus
   * @param {string | null} [error]
   */
  async function markCommandDelivery(
    id,
    commandId,
    deliveryStatus,
    error = null,
  ) {
    if (!MESSAGE_DELIVERY_STATUSES.has(deliveryStatus)) {
      throw new LauncherError("Estado de entrega inválido.", 400);
    }
    const store = await settled(id);
    let updated = null;
    await change(store, (state) => {
      const cmd = state.commands.find(
        (c) => c.id === commandId || c.clientMessageId === commandId,
      );
      if (!cmd) throw new LauncherError("Comando no encontrado.", 404);
      cmd.deliveryStatus = deliveryStatus;
      cmd.error = error;
      cmd.updatedAt = new Date().toISOString();
      updated = cmd;
    });
    return structuredClone(updated);
  }

  /** @param {string} id */
  async function listQueue(id) {
    const store = await settled(id);
    return structuredClone(store.state.queue);
  }

  /**
   * @param {string} id
   * @param {string} clientMessageId
   */
  async function cancelQueuedMessage(id, clientMessageId) {
    const store = await settled(id);
    const idx = store.state.queue.findIndex(
      (q) =>
        q.clientMessageId === clientMessageId ||
        q.commandId === clientMessageId,
    );
    if (idx === -1) {
      throw new LauncherError(
        "El mensaje ya fue entregado o no está en la cola.",
        409,
      );
    }
    let cancelled = null;
    await change(store, (state) => {
      const [removed] = state.queue.splice(idx, 1);
      const cmd = state.commands.find((c) => c.id === removed.commandId);
      if (cmd) {
        cmd.deliveryStatus = "fallido";
        cmd.cancelled = true;
        cmd.error = "Cancelado de la cola antes de entregarse.";
        cmd.updatedAt = new Date().toISOString();
        cancelled = cmd;
      }
    });
    return { ok: true, command: structuredClone(cancelled) };
  }

  /** @param {string} id */
  async function consumeNextQueuedMessage(id) {
    const store = await settled(id);
    if (store.state.queue.length === 0) return null;
    /** @type {QueuedConversationMessage | null} */
    let nextItem = null;
    await change(store, (state) => {
      nextItem = state.queue.shift() || null;
      const item = nextItem;
      if (item) {
        const cmd = state.commands.find((c) => c.id === item.commandId);
        if (cmd) {
          cmd.deliveryStatus = "entregado";
          cmd.updatedAt = new Date().toISOString();
        }
      }
    });
    // Assigned inside change(); TypeScript cannot see writes from closures.
    return structuredClone(
      /** @type {QueuedConversationMessage | null} */ (nextItem),
    );
  }

  return {
    sendMessage,
    markCommandDelivery,
    listQueue,
    cancelQueuedMessage,
    consumeNextQueuedMessage,
  };
}
