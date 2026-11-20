import { StringDecoder } from "node:string_decoder";

/** @typedef {number | string | null} RpcId */
/**
 * @typedef {import("node:child_process").ChildProcessByStdio<
 *   import("node:stream").Writable,
 *   import("node:stream").Readable,
 *   import("node:stream").Readable | null
 * >} ProviderChild
 */
/** @typedef {{ written: boolean, rpcId: RpcId }} RpcWriteAcknowledgment */
/** @typedef {{ writeAck: Promise<RpcWriteAcknowledgment>, isWritable: () => boolean }} RpcRequestMetadata */
/**
 * @typedef {object} RpcOptions
 * @property {(method: string, params: unknown) => unknown} [notify]
 * @property {(method: string, params: unknown, id: RpcId, metadata: RpcRequestMetadata) => unknown} [request]
 * @property {(reason: string) => void} [onClose]
 * @property {number} [timeout]
 */
/**
 * @typedef {object} RpcMessage
 * @property {RpcId} [id]
 * @property {string} [method]
 * @property {unknown} [params]
 * @property {unknown} [result]
 * @property {{ code?: number, message?: string, data?: unknown }} [error]
 */
/**
 * @typedef {object} PendingCall
 * @property {(result: unknown) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {NodeJS.Timeout | undefined} timer
 */

/**
 * Newline-delimited JSON-RPC; no PTY, ANSI parsing or transcript polling.
 * @param {ProviderChild} child
 * @param {RpcOptions} [options]
 */
export function providerRpc(
  child,
  {
    notify = () => {},
    request = async () => {
      throw new Error("Método no compatible");
    },
    onClose = () => {},
    timeout = 30000,
  } = {},
) {
  let sequence = 0;
  let buffer = "";
  let closed = false;
  let exited = false;
  const decoder = new StringDecoder("utf8");
  /** @type {Map<RpcId, PendingCall>} */
  const pending = new Map();
  const isWritable = () =>
    !closed &&
    !exited &&
    Boolean(
      child?.stdin &&
      child.stdin.writable &&
      !child.stdin.destroyed &&
      !child.stdin.writableEnded &&
      (child.exitCode === null || child.exitCode === undefined),
    );
  /** @param {unknown} value */
  const serialize = (value) => JSON.stringify(value) + "\n";
  /** @param {unknown} value */
  const write = (value) => {
    if (!isWritable()) throw new Error("Proveedor desconectado");
    child.stdin.write(serialize(value));
  };
  /**
   * @param {unknown} value
   * @returns {Promise<{ bytes: number }>}
   */
  const writeAsync = (value) =>
    new Promise((resolve, reject) => {
      if (!isWritable()) {
        reject(new Error("Proveedor desconectado"));
        return;
      }
      const line = serialize(value);
      const onClosedBeforeFlush = () => {
        cleanup();
        reject(new Error("Conexión cerrada durante el envío"));
      };
      const cleanup = () => {
        child.off("exit", onClosedBeforeFlush);
        child.off("error", onClosedBeforeFlush);
        child.stdin.off("error", onClosedBeforeFlush);
      };
      child.once("exit", onClosedBeforeFlush);
      child.once("error", onClosedBeforeFlush);
      child.stdin.once("error", onClosedBeforeFlush);
      try {
        child.stdin.write(line, "utf8", (err) => {
          cleanup();
          if (err) reject(err);
          else if (
            exited ||
            (child.exitCode !== null && child.exitCode !== undefined)
          ) {
            reject(new Error("Proveedor desconectado"));
          } else {
            resolve({ bytes: Buffer.byteLength(line, "utf8") });
          }
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  const close = (reason = "Proveedor desconectado") => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
    try {
      onClose(reason);
    } catch {
      /* observers must not fail close */
    }
  };
  child.once("error", () => close("Error en proceso proveedor"));
  child.once("exit", () => {
    exited = true;
    close("Proveedor desconectado");
  });
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 8 * 1024 * 1024) {
      close("Límite de buffer JSON-RPC excedido");
      child.kill();
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      /** @type {RpcMessage} */
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        close("Trama JSON-RPC inválida");
        child.kill();
        return;
      }
      const { method, id } = message;
      if (method && id !== undefined) {
        /** @type {PromiseWithResolvers<RpcWriteAcknowledgment>} */
        const {
          promise: writeAck,
          resolve: resolveWriteAck,
          reject: rejectWriteAck,
        } = Promise.withResolvers();
        writeAck.catch(() => {});
        Promise.resolve()
          .then(() =>
            request(method, message.params, id, {
              writeAck,
              isWritable,
            }),
          )
          .then(async (result) => {
            await writeAsync({ jsonrpc: "2.0", id, result });
            resolveWriteAck({ written: true, rpcId: id });
          })
          .catch(async (err) => {
            rejectWriteAck(err);
            if (isWritable()) {
              await writeAsync({
                jsonrpc: "2.0",
                id,
                error: {
                  code: err?.rpcCode || -32601,
                  message: err?.message || "Solicitud no disponible",
                },
              }).catch(() => {});
            }
          });
      } else if (method) {
        Promise.resolve(notify(method, message.params)).catch(() =>
          close("Fallo procesando notificación"),
        );
      } else if (id !== undefined) {
        const p = pending.get(id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(id);
        if (message.error)
          p.reject(
            Object.assign(new Error("El proveedor rechazó la operación"), {
              code: message.error.code,
              rpcMessage: message.error.message,
              data: message.error.data,
            }),
          );
        else p.resolve(message.result);
      }
    }
  });
  return {
    close,
    isClosed: () => closed,
    isWritable,
    writeAsync,
    /**
     * @param {string} method
     * @param {unknown} params
     */
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    /**
     * @param {string} method
     * @param {unknown} params
     * @returns {Promise<unknown>}
     */
    call(method, params, ms = timeout) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = ms
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error("El proveedor no confirmó la operación"));
            }, ms)
          : undefined;
        pending.set(id, { resolve, reject, timer });
        try {
          write({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}
