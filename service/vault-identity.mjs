import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
export const hash = (s) => createHash("sha256").update(s).digest("hex");
/** Who is writing, set per request, so the history can say which agent changed a note. */
export const actorContext = new AsyncLocalStorage();
export function stableId(s) {
  const h = hash(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export class Failure extends Error {
  constructor(message, status = 400, server) {
    super(message);
    this.status = status;
    this.server = server;
  }
}
