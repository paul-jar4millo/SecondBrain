// @ts-check
import { StringDecoder } from "node:string_decoder";

/** Newline-delimited JSON-RPC; no PTY, ANSI parsing or transcript polling. */
export function providerRpc(
  child,
  {
    notify = /** @type {(...args: any[]) => any} */ (() => {}),
    request = /** @type {(...args: any[]) => Promise<any>} */ (
      async () => {
        throw new Error("Método no compatible");
      }
    ),
    onClose = /** @type {(...args: any[]) => any} */ (() => {}),
    timeout = 30000,
  } = /** @type {any} */ ({}),
) {
  let sequence = 0;
  let buffer = "";
  let closed = false;
  let exited = false;
  const decoder = new StringDecoder("utf8");
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
  const serialize = (value) => JSON.stringify(value) + "\n";
  const write = (value) => {
    if (!isWritable()) throw new Error("Proveedor desconectado");
    child.stdin.write(serialize(value));
  };
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
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        close("Trama JSON-RPC inválida");
        child.kill();
        return;
      }
      if (message.method && message.id !== undefined) {
        let resolveWriteAck;
        let rejectWriteAck;
        const writeAck = new Promise((resolve, reject) => {
          resolveWriteAck = resolve;
          rejectWriteAck = reject;
        });
        writeAck.catch(() => {});
        Promise.resolve()
          .then(() =>
            request(message.method, message.params, message.id, {
              writeAck,
              isWritable,
            }),
          )
          .then(async (result) => {
            await writeAsync({ jsonrpc: "2.0", id: message.id, result });
            resolveWriteAck({ written: true, rpcId: message.id });
          })
          .catch(async (err) => {
            rejectWriteAck(err);
            if (isWritable()) {
              await writeAsync({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: err?.rpcCode || -32601,
                  message: err?.message || "Solicitud no disponible",
                },
              }).catch(() => {});
            }
          });
      } else if (message.method) {
        Promise.resolve(notify(message.method, message.params)).catch(() =>
          close("Fallo procesando notificación"),
        );
      } else if (pending.has(message.id)) {
        const p = pending.get(message.id);
        clearTimeout(p.timer);
        pending.delete(message.id);
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
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    call(method, params, ms = timeout) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = ms
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error("El proveedor no confirmó la operación"));
            }, ms)
          : null;
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
