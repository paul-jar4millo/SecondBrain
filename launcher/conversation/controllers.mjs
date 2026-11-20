/** @import {ConversationAdapter, ConversationConnection, ConversationController, ConversationJob} from "../provider-conversation-types.mjs" */
/** @import {ConversationPersistence} from "./persistence.mjs" */

/**
 * State shared by every part of a conversation manager: the persisted
 * sessions, the turn running in each one, and each session's live provider
 * process.
 * @typedef {{
 *   persistence: ConversationPersistence,
 *   adapters: Record<string, ConversationAdapter>,
 *   running: Map<string, ConversationJob>,
 *   controllers: Map<string, { controller: ConversationController, configSignature: string }>
 * }} ConversationRuntime
 */

/**
 * Lifecycle of the persistent provider processes (one per session).
 * @param {ConversationRuntime} runtime
 */
export function createControllerRegistry({
  persistence,
  adapters,
  running,
  controllers,
}) {
  /**
   * @param {string} id
   * @param {{ reason?: string }} [options]
   * @returns {Promise<{ closed: boolean, id: string, pid: number | null, reason?: string }>}
   */
  async function shutdown(id, { reason = "Cierre explícito" } = {}) {
    const entry = controllers.get(id);
    if (!entry) return { closed: false, id, pid: null };
    const oldPid = entry.controller.pid();
    controllers.delete(id);
    const liveJob = running.get(id);
    if (liveJob) {
      liveJob.invalidateCallbacks("interrupted", reason);
    }
    try {
      await entry.controller.shutdown(reason);
    } catch {
      /* ensure cleanup proceeds even on dead child */
    }
    const store = await persistence
      .load(id)
      .catch(/** @returns {null} */ () => null);
    if (store) {
      const evicted = /evic|límite|recurso/i.test(reason);
      /** @type {ConversationConnection} */
      const nextConn = {
        status: evicted ? "evicted" : "closed",
        pid: null,
        connectionId: entry.controller.connectionId,
        reason,
        updatedAt: new Date().toISOString(),
      };
      await persistence
        .change(store, (state) => {
          state.connection = nextConn;
          persistence.pushEvent(state, id, {
            type: "connection.status",
            sourceId: "controller",
            payload: nextConn,
          });
        })
        .catch(() => {});
    }
    return { closed: true, id, pid: oldPid, reason };
  }

  async function shutdownAll(reason = "Apagado del lanzador") {
    const ids = [...controllers.keys()];
    await Promise.allSettled(ids.map((id) => shutdown(id, { reason })));
  }

  /** @param {string[]} [excludeIds] */
  async function evictOldestIdle(
    reason = "Cerrada por límite de procesos activos",
    excludeIds = [],
  ) {
    const blocked = new Set(excludeIds);
    const candidates = [...controllers.entries()]
      .filter(
        ([id, entry]) =>
          !blocked.has(id) && !running.has(id) && entry.controller.isAlive(),
      )
      .sort((a, b) => a[1].controller.lastUsedAt - b[1].controller.lastUsedAt);
    if (candidates.length === 0) return null;
    const [victimId] = candidates[0];
    return shutdown(victimId, { reason });
  }

  /** @param {string} id */
  function hasLiveController(id) {
    return Boolean(controllers.get(id)?.controller?.isAlive());
  }

  function liveSessions() {
    const items = [];
    for (const [id, entry] of controllers.entries()) {
      if (!entry.controller.isAlive()) {
        controllers.delete(id);
        continue;
      }
      items.push({
        id,
        motor: entry.controller.motor,
        pid: entry.controller.pid(),
        connectionId: entry.controller.connectionId,
        state: running.has(id) ? "ocupado" : "ocioso",
        lastUsedAt: entry.controller.lastUsedAt,
        createdAt: entry.controller.createdAt,
        capabilities: entry.controller.capabilities?.() || {},
      });
    }
    return items;
  }

  /** @param {string} idOrEngine */
  function capabilities(idOrEngine) {
    const entry = controllers.get(idOrEngine);
    if (entry?.controller?.capabilities) {
      return entry.controller.capabilities();
    }
    if (adapters[idOrEngine]?.createController) {
      const tmp = adapters[idOrEngine].createController();
      return tmp.capabilities?.() || {};
    }
    return {
      persistentProcess: false,
      supportsSteer: false,
      supportsInterrupt: false,
      supportsResume: false,
    };
  }

  return {
    shutdown,
    shutdownAll,
    evictOldestIdle,
    hasLiveController,
    liveSessions,
    capabilities,
  };
}
