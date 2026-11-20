// Messages sent to a structured session: delivered now, steered into the
// running turn or queued until the turn ends.
import { ErrorLanzador } from "../errors.mjs";
import { validarAdjuntosMotor } from "../engines.mjs";
/** @import { TurnOptions } from "../types.d.ts" */
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {{
 *   drenarCola: (id: string) => Promise<void>,
 *   continuar: (id: string, brief: string, turnOptions?: TurnOptions) => Promise<LauncherSession | undefined>,
 * }} deps Turn orchestration that stays in the executor.
 */
export function createConversationQueue(config, state, deps) {
  const { conversations, registro } = config;
  const { activos } = state;
  const { continuar, drenarCola } = deps;
  /**
   * @param {string} id
   * @param {{ clientMessageId?: string, text?: string, mode?: string, attachments?: any[] }} [message]
   */
  async function enviarMensaje(
    id,
    { clientMessageId, text = "", mode = "send", attachments = [] } = {},
  ) {
    if (!conversations) {
      throw new ErrorLanzador("Integración estructurada no instalada.", 503);
    }
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    if (!sesion) throw new ErrorLanzador("Sesión inexistente.", 404);
    if (!sesion.structured) {
      throw new ErrorLanzador(
        "La sesión no admite mensajería estructurada.",
        409,
      );
    }
    const validatedAttachments = validarAdjuntosMotor(
      sesion.motor,
      attachments,
      sesion.directorio || "",
    );
    const isWorking = activos.has(id);
    if (isWorking) {
      const accepted = await conversations.sendMessage(id, {
        clientMessageId,
        text,
        mode,
        attachments: validatedAttachments,
        online: true,
        queueIfIdle: true,
      });
      // The turn may have ended while the message was being queued.
      if (accepted.queued) await drenarCola(id);
      return accepted;
    }
    if (mode === "queue") {
      return conversations.sendMessage(id, {
        clientMessageId,
        text,
        mode: "queue",
        attachments: validatedAttachments,
        online: false,
      });
    }
    const accepted = await conversations.sendMessage(id, {
      clientMessageId,
      text,
      mode: "send",
      attachments: validatedAttachments,
      online: true,
    });
    if (accepted.repetido) return accepted;
    const command = accepted.command;
    if (!command) throw new Error("No se pudo aceptar el mensaje.");
    if (!sesion.conversacionId) {
      await conversations.markCommandDelivery(
        id,
        command.id,
        "entrega_incierta",
        "Falta identificador nativo de sesión para continuar.",
      );
      return {
        ...accepted,
        command: { ...command, deliveryStatus: "entrega_incierta" },
      };
    }
    await continuar(id, command.text, {
      attachments: command.attachments,
      commandId: command.id,
    });
    const updatedCmd = await conversations.markCommandDelivery(
      id,
      command.id,
      "entregado",
    );
    return { ...accepted, command: updatedCmd, started: true };
  }
  /** @param {string} id */
  const listarCola = (id) => {
    if (!conversations) {
      throw new ErrorLanzador("Integración estructurada no instalada.", 503);
    }
    return conversations.listQueue(id);
  };
  /**
   * @param {string} id
   * @param {string} clientMessageId
   */
  const cancelarCola = (id, clientMessageId) => {
    if (!conversations) {
      throw new ErrorLanzador("Integración estructurada no instalada.", 503);
    }
    return conversations.cancelQueuedMessage(id, clientMessageId);
  };
  return {
    enviarMensaje,
    listarCola,
    cancelarCola,
  };
}
