// Base for the stores' errors (work orders, user requests, effects). The HTTP
// layer turns any DomainError into a Failure with the same status, carrying
// the optional details below to the client.
export class DomainError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    /** @type {unknown} Receipt of the decision that already resolved the request. */
    this.recibo;
    /** @type {unknown} Public summary of the request involved. */
    this.solicitud;
    /** @type {unknown} State of the store when the error happened. */
    this.snapshot;
    /** @type {unknown} Operation involved, for effects. */
    this.operacion;
    Object.assign(this, details);
  }
}
