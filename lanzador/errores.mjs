/**
 * An error whose message is written in Spanish for the user and is safe to
 * show as is. The HTTP layer answers with `status`; anything else stays generic.
 */
export class ErrorLanzador extends Error {
  constructor(mensaje, status = 409) {
    super(mensaje);
    this.name = "ErrorLanzador";
    this.status = status;
  }
}
