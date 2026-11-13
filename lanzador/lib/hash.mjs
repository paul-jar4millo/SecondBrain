// @ts-check
import { createHash } from "node:crypto";

/**
 * Hex SHA-256 of a string (hashed as UTF-8) or of raw bytes.
 * @param {string | Uint8Array} value
 */
export function sha256Hex(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}
