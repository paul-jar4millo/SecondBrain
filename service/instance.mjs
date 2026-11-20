import { open, readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
async function processStart(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const started = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    const boot = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    return `${boot}:${started}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function acquireInstance(directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "instance.lock"),
    nonce = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(file, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = await readFile(file, "utf8");
      let owner;
      try {
        owner = JSON.parse(prior);
      } catch {
        throw new Error(
          "Otra instancia está iniciando o el bloqueo necesita revisión.",
          { cause: error },
        );
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Error("Bloqueo de instancia inválido.", { cause: error });
      const started = await processStart(owner.pid);
      if (!owner.started || !started || started === owner.started) {
        try {
          process.kill(owner.pid, 0);
          throw new Error("Ya existe una instancia activa.", { cause: error });
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      }
      if ((await readFile(file, "utf8")) !== prior)
        throw new Error("Otra instancia cambió el bloqueo.", { cause: error });
      await unlink(file);
    }
  }
  if (!handle) throw new Error("No se pudo reservar la instancia.");
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        nonce,
        started: await processStart(process.pid),
      }),
    );
  } finally {
    await handle.close();
  }
  return async () => {
    const owner = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
    if (owner?.nonce === nonce) await unlink(file);
  };
}
