import { LauncherError } from "../errors.mjs";

/** @import {ConversationState} from "../provider-conversation-types.mjs" */

/**
 * Streams a structured conversation as Server-Sent Events: one full snapshot
 * on connect and another after every persisted change.
 * @param {{
 *   res: import("node:http").ServerResponse,
 *   id: string,
 *   conversations: {
 *     snapshot(id: string): Promise<ConversationState>,
 *     subscribe(id: string, listener: () => void): Promise<() => unknown>
 *   },
 *   registro: {
 *     leer(): readonly { id: string, eliminada?: boolean, structured?: boolean, estado?: string, error?: string | null }[],
 *     subscribe(listener: () => void): () => void
 *   }
 * }} options
 */
export async function serveProviderConversation({
  res,
  id,
  conversations,
  registro: registry,
}) {
  const session = registry.leer().find((s) => s.id === id && !s.eliminada);
  if (!session?.structured)
    throw new LauncherError("Conversación estructurada no disponible.", 409);
  let closed = false;
  /** @type {Promise<void | import("node:http").ServerResponse>} */
  let pending = Promise.resolve();
  const send = () => {
    pending = pending
      .then(async () => {
        const state = await conversations.snapshot(id);
        if (closed) return;
        if (res.writableLength > 4 * 1024 * 1024) return res.end();
        const current = registry.leer().find((s) => s.id === id);
        res.write(
          `event: conversation\ndata: ${JSON.stringify({ ...state, status: current?.estado, error: current?.error })}\n\n`,
        );
      })
      .catch(() => res.end());
  };
  const off = await conversations.subscribe(id, send);
  const offRegistry = registry.subscribe(send);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  heartbeat.unref();
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    off();
    offRegistry();
  });
  send();
}
