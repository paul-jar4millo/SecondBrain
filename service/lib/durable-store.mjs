// Shared persistence primitives for the journaled stores (work orders, user
// requests and effects): an append-only JSON-lines journal plus an atomic
// snapshot, and a queue that serializes their writes.
import { open, rename, writeFile } from "node:fs/promises";

/**
 * Writes `data` as JSON to `file` through a temporary file and a rename, so a
 * reader never sees a partial snapshot. The file is private to the service user.
 * @param {string} file
 * @param {unknown} data
 */
export async function writeJsonAtomically(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Appends one JSON record as a line and fsyncs it before returning.
 * @param {string} file
 * @param {unknown} record
 */
export async function appendJsonLine(file, record) {
  const fh = await open(file, "a", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Returns a function that runs tasks one after another. A failing task rejects
 * its own promise without blocking the tasks queued after it. `drain()`
 * resolves once every task queued so far has settled.
 */
export function createSerialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>}
   */
  function serial(task) {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  }
  serial.drain = () => tail;
  return serial;
}
