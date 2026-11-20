import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LauncherError } from "../errors.mjs";

/** @import {ConversationEvent, ConversationEventInput, ConversationRequest, ConversationState, ConversationStore, NativeCallbackStatus} from "../provider-conversation-types.mjs" */

/** @type {Set<string>} */
export const MESSAGE_DELIVERY_STATUSES = new Set([
  "recibido",
  "en_cola",
  "entregado",
  "confirmado_proveedor",
  "fallido",
  "entrega_incierta",
]);

export const REQUEST_DELIVERY_STATUSES = new Set([
  "respuesta_recibida",
  "entregando",
  "entregada",
  "confirmada",
  "entrega_incierta",
]);

/** @param {unknown} id */
export const validId = (id) =>
  typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id);

/**
 * JSON with sorted keys, so equal values compare equal as strings.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(entries).sort();
    return `{${keys
      .filter((k) => entries[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(entries[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Closes a request whose native callback can no longer be answered. A question
 * goes back to "pendiente" and needs a new turn to be asked again.
 * @param {ConversationRequest} request
 * @param {NativeCallbackStatus} nativeStatus
 */
export function expireRequest(request, nativeStatus) {
  request.status = "expired";
  request.nativeCallbackStatus = nativeStatus;
  if (request.kind === "question") {
    request.productStatus = "pendiente";
    request.requiresNewTurn = true;
  }
}

/**
 * @param {Partial<ConversationState>} state
 * @returns {ConversationState}
 */
function ensureStateShape(state) {
  state.seq ??= 0;
  state.items ??= [];
  state.requests ??= [];
  state.receipts ??= [];
  state.commands ??= [];
  state.queue ??= [];
  state.artifacts ??= [];
  state.events ??= [];
  state.eventSeq ??= state.events.length;
  state.lastTurnStatus ??= null;
  state.connection ??= null;
  return /** @type {ConversationState} */ (state);
}

/**
 * One JSON file per session, written atomically and in order.
 * @param {{
 *   directory: string,
 *   onEvent: (sessionId: string, event: ConversationEvent) => void
 * }} options
 */
export function createConversationPersistence({ directory, onEvent }) {
  /** @type {Map<string, Promise<ConversationStore>>} */
  const stores = new Map();

  /**
   * @param {string} id
   * @returns {Promise<ConversationStore>}
   */
  async function load(id) {
    if (!validId(id)) throw new LauncherError("Sesión inválida.", 400);
    let pending = stores.get(id);
    if (!pending) {
      pending = (async () => {
        let state;
        const filename = path.join(directory, `${id}.json`);
        try {
          state = ensureStateShape(
            JSON.parse(await readFile(filename, "utf8")),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          state = ensureStateShape({});
        }
        // A callback belongs strictly to its live process, never across restarts.
        let changed = false;
        for (const request of state.requests) {
          if (request.status === "pending") {
            expireRequest(request, "interrupted");
            changed = true;
          }
        }
        /** @type {ConversationStore} */
        const store = {
          state,
          filename,
          listeners: new Set(),
          queue: Promise.resolve(),
        };
        if (changed) await save(store);
        return store;
      })();
      stores.set(id, pending);
    }
    return pending;
  }

  /** @param {ConversationStore} store */
  function save(store) {
    const content = JSON.stringify(store.state);
    const write = store.queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(store.filename + ".tmp", content, { mode: 0o600 });
      await rename(store.filename + ".tmp", store.filename);
      for (const listener of store.listeners) {
        try {
          listener();
        } catch {
          /* An observer cannot undo persistence. */
        }
      }
    });
    store.queue = write.catch(() => {});
    return write;
  }

  /**
   * @param {ConversationState} state
   * @param {string} sessionId
   * @param {ConversationEventInput} ev
   */
  function pushEvent(state, sessionId, ev) {
    const event = {
      id: ev.id || randomUUID(),
      sequence: ++state.eventSeq,
      sessionId,
      turnId: ev.turnId ?? null,
      nativeItemId: ev.nativeItemId ?? null,
      correlationId: ev.correlationId ?? null,
      sourceId: ev.sourceId ?? "provider",
      type: ev.type,
      timestamp: new Date().toISOString(),
      payloadVersion: 1,
      payload: ev.payload ?? {},
    };
    state.events.push(event);
    if (state.events.length > 2000) {
      state.events = state.events.slice(-2000);
    }
    try {
      onEvent(sessionId, event);
    } catch {
      /* External listeners must not abort persistence. */
    }
    return event;
  }

  /**
   * @param {ConversationStore} store
   * @param {(state: ConversationState) => void} fn
   */
  function change(store, fn) {
    fn(store.state);
    store.state.seq++;
    store.state.updatedAt = new Date().toISOString();
    return save(store);
  }

  /**
   * Loads a session and waits for its pending writes.
   * @param {string} id
   */
  async function settled(id) {
    const store = await load(id);
    await store.queue;
    return store;
  }

  /** @param {string} id */
  async function snapshot(id) {
    const store = await settled(id);
    return structuredClone(store.state);
  }

  return {
    directory,
    load,
    settled,
    change,
    pushEvent,
    snapshot,
    /** @param {string} id */
    forget: (id) => stores.delete(id),
  };
}

/** @typedef {ReturnType<typeof createConversationPersistence>} ConversationPersistence */
