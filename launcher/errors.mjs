/**
 * An error whose message is written in Spanish for the user and is safe to
 * show as is. The HTTP layer answers with `status`; anything else stays generic.
 */
export class LauncherError extends Error {
  /** @param {string} message */
  constructor(message, status = 409) {
    super(message);
    this.name = "LauncherError";
    this.status = status;
  }
}
