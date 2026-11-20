// Client for the launcher's thread API (ADR 0010). Identifiers are checked
// here so a path never carries anything but a well-formed id.

const THREAD = /^thr_[0-9A-Za-z_-]{6,64}$/;
const REQUEST = /^req_[0-9A-Za-z_-]{6,64}$/;
const TURN = /^trn_[0-9A-Za-z_-]{6,64}$/;

/**
 * @param {{
 *   base: string | undefined,
 *   secret: () => Promise<string>,
 *   request: (path: string, data?: unknown, timeout?: number) => Promise<any>,
 *   Failure: typeof import("./vault.mjs").Failure,
 * }} deps
 */
export function createThreadsClient({ base, secret, request, Failure }) {
  /**
   * @param {RegExp} pattern
   * @param {string} message
   */
  const check = (pattern, message) => (/** @type {unknown} */ id) => {
    if (typeof id !== "string" || !pattern.test(id))
      throw new Failure(message, 400);
    return id;
  };
  const thread = check(THREAD, "Thread inválido.");
  const req = check(REQUEST, "Solicitud inválida.");
  const turn = check(TURN, "Turno inválido.");

  return {
    /** @param {URLSearchParams} [query] */
    list: (query) =>
      request(`/threads${query && [...query].length ? `?${query}` : ""}`),
    /** @param {unknown} data */
    create: (data) => request("/threads", data, 45_000),
    /** @param {unknown} id */
    snapshot: (id) => request(`/threads/${thread(id)}`),
    /**
     * @param {unknown} id
     * @param {unknown} data
     */
    send: (id, data) => request(`/threads/${thread(id)}/messages`, data),
    /** @param {unknown} id */
    interrupt: (id) => request(`/threads/${thread(id)}/interrupt`, {}),
    /**
     * @param {unknown} id
     * @param {unknown} requestId
     * @param {unknown} data
     */
    answer: (id, requestId, data) =>
      request(`/threads/${thread(id)}/requests/${req(requestId)}`, data),
    /**
     * @param {unknown} id
     * @param {unknown} data
     */
    ask: (id, data) => request(`/threads/${thread(id)}/ask`, data),
    /**
     * @param {unknown} id
     * @param {unknown} requestId
     */
    request: (id, requestId) =>
      request(`/threads/${thread(id)}/requests/${req(requestId)}`),
    /**
     * @param {unknown} id
     * @param {unknown} data
     */
    close: (id, data) => request(`/threads/${thread(id)}/close`, data, 180_000),
    /** @param {unknown} id */
    archive: (id) => request(`/threads/${thread(id)}/archive`, {}, 60_000),
    /**
     * @param {unknown} id
     * @param {unknown} [turnId]
     */
    diff: (id, turnId) =>
      request(
        turnId
          ? `/threads/${thread(id)}/turns/${turn(turnId)}/diff`
          : `/threads/${thread(id)}/diff`,
        undefined,
        30_000,
      ),
    inbox: () => request("/inbox"),
    /**
     * Opens a launcher SSE stream (one thread, or the global feed when `id`
     * is null) and returns the raw response for the caller to pipe.
     * @param {unknown} id
     * @param {{ after?: string | null, lastEventId?: string | null, signal: AbortSignal }} options
     */
    stream: async (id, { after = null, lastEventId = null, signal }) => {
      if (!base) throw new Failure("El lanzador no está instalado.", 503);
      const path =
        id === null ? "/threads/stream" : `/threads/${thread(id)}/stream`;
      const query = after && /^\d{1,15}$/.test(after) ? `?after=${after}` : "";
      /** @type {Record<string, string>} */
      const headers = {
        authorization: `Bearer ${await secret()}`,
        accept: "text/event-stream",
      };
      if (lastEventId && /^\d{1,15}$/.test(lastEventId))
        headers["last-event-id"] = lastEventId;
      let response;
      try {
        response = await fetch(base + path + query, {
          headers,
          signal,
          redirect: "error",
        });
      } catch {
        throw new Failure("El lanzador no responde.", 503);
      }
      if (!response.ok || !response.body) {
        const content = await response.json().catch(() => ({}));
        await response.body?.cancel().catch(() => {});
        throw new Failure(
          content.seguro === true
            ? content.error
            : "El lanzador rechazó la petición.",
          response.status,
        );
      }
      return response;
    },
  };
}
