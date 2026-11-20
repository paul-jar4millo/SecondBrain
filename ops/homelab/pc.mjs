import net from "node:net";
import dgram from "node:dgram";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function magicPacket(mac) {
  if (typeof mac !== "string" || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac))
    throw new Error("MAC inválida");
  const address = Buffer.from(mac.replaceAll(":", ""), "hex");
  return Buffer.concat([
    Buffer.alloc(6, 255),
    ...Array.from({ length: 16 }, () => address),
  ]);
}

export function probe({ host, port = 445, timeoutMs = 1000 }) {
  if (
    net.isIP(host) !== 4 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Destino inválido");
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (responding) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ state: responding ? "responding" : "unknown", responding });
    };
    socket.setTimeout(Math.ceil(timeoutMs), () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function wake({
  host,
  port = 445,
  mac,
  broadcast,
  wolPort = 9,
  deadlineMs = 120000,
}) {
  const packet = magicPacket(mac);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 120000)
    throw new Error("El plazo debe estar entre 1 y 120000 ms");
  if (
    net.isIP(broadcast) !== 4 ||
    !Number.isInteger(wolPort) ||
    wolPort < 1 ||
    wolPort > 65535
  )
    throw new Error("Broadcast inválido");
  const deadline = performance.now() + deadlineMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  if (
    (await probe({ host, port, timeoutMs: Math.min(700, remaining()) }))
      .responding
  )
    return { state: "responding", sent: false };
  if (remaining() <= 0) return { state: "unknown", sent: false };
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Se agotó el plazo de envío"));
    }, Math.ceil(remaining()));
    const finish = (error) => {
      clearTimeout(timeout);
      socket.close();
      error ? reject(error) : resolve();
    };
    socket.once("error", finish);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, wolPort, broadcast, finish);
    });
  });
  while (remaining() > 0) {
    await delay(Math.min(500, remaining()));
    if (remaining() <= 0) break;
    if (
      (await probe({ host, port, timeoutMs: Math.min(700, remaining()) }))
        .responding
    )
      return { state: "responding", sent: true };
  }
  return { state: "unknown", sent: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
) {
  try {
    const action = process.argv[2];
    if (!["status", "wake"].includes(action))
      throw new Error("Usar status o wake");
    const settings = JSON.parse(
      await readFile(
        process.env.SB_HOMELAB_CONFIG || "/etc/sb-agente/pc.json",
        "utf8",
      ),
    );
    const result =
      action === "status" ? await probe(settings) : await wake(settings);
    console.log(
      result.state === "responding"
        ? "La PC responde en TCP 445."
        : result.sent
          ? "Magic packet enviado; la PC no respondió dentro del plazo. Estado de energía sin confirmar."
          : "La PC no responde en TCP 445. Estado de energía sin confirmar.",
    );
    process.exitCode = result.state === "responding" ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
