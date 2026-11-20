import { rm } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_ADAPTERS } from "./provider-adapters.mjs";
import { LauncherError } from "./errors.mjs";
import { createAnswerHandler } from "./conversation/answers.mjs";
import { readArtifact } from "./conversation/artifacts.mjs";
import { createControllerRegistry } from "./conversation/controllers.mjs";
import { createMessageQueue } from "./conversation/messages.mjs";
import { createConversationPersistence } from "./conversation/persistence.mjs";
import { createTurnRunner } from "./conversation/turn.mjs";

export {
  MESSAGE_DELIVERY_STATUSES,
  REQUEST_DELIVERY_STATUSES,
} from "./conversation/persistence.mjs";
export { serveProviderConversation } from "./conversation/stream.mjs";

/** @import {ConversationAdapter, ConversationEvent} from "./provider-conversation-types.mjs" */
/** @import {ConversationRuntime} from "./conversation/controllers.mjs" */

/**
 * Durable protocol events, commands, queues, artifacts, and requests; zero PTY/transcript inference.
 * The parts live in ./conversation/: persistence, controllers (live provider
 * processes), turn, messages, answers, artifacts and stream.
 * @param {{
 *   directory: string,
 *   adapters?: Record<string, ConversationAdapter>,
 *   onEvent?: (sessionId: string, event: ConversationEvent) => void
 * }} options
 */
export function createProviderConversations({
  directory,
  adapters = PROVIDER_ADAPTERS,
  onEvent = () => {},
}) {
  /** @type {ConversationRuntime} */
  const runtime = {
    persistence: createConversationPersistence({ directory, onEvent }),
    adapters,
    running: new Map(),
    controllers: new Map(),
  };
  const { persistence, running, controllers } = runtime;
  const registry = createControllerRegistry(runtime);

  return {
    run: createTurnRunner({
      ...runtime,
      shutdownController: registry.shutdown,
    }),
    snapshot: persistence.snapshot,
    ...createMessageQueue(runtime),
    hasLiveController: registry.hasLiveController,
    liveSessions: registry.liveSessions,
    capabilities: registry.capabilities,
    shutdown: registry.shutdown,
    shutdownAll: registry.shutdownAll,
    evictOldestIdle: registry.evictOldestIdle,
    /**
     * @param {string} sessionId
     * @param {string} artifactId
     */
    readArtifact: (sessionId, artifactId) =>
      readArtifact(persistence, sessionId, artifactId),
    /** @param {string} id */
    async remove(id) {
      if (running.has(id))
        throw new LauncherError("Detén la sesión antes de eliminarla", 409);
      if (controllers.has(id)) {
        await registry.shutdown(id, { reason: "Conversación eliminada" });
      }
      const store = await persistence.settled(id);
      await rm(store.filename, { force: true });
      await rm(path.join(directory, "_blobs", id), {
        recursive: true,
        force: true,
      }).catch(() => {});
      persistence.forget(id);
    },
    /** @param {string} id */
    abort: (id) => running.get(id)?.abort(),
    /**
     * @param {string} id
     * @param {() => void} listener
     */
    async subscribe(id, listener) {
      const store = await persistence.load(id);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    answer: createAnswerHandler(runtime),
  };
}
