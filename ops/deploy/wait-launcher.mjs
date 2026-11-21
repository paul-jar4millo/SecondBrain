import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

// Waits until no thread is mid-turn, so the deploy can restart the launcher.
// Read live state: an unreachable launcher or an unexpected answer must never
// authorize a restart.
const BUSY = "setting-up,running,waiting-user,closing";

try {
  const wait = Number(process.env.SB_DEPLOY_WAIT_MS ?? 900000);
  const poll = Number(process.env.SB_DEPLOY_POLL_MS ?? 5000);
  if (!Number.isFinite(wait) || wait < 0 || !Number.isFinite(poll) || poll <= 0)
    throw new Error();
  const token = (
    await readFile(
      process.env.SB_LAUNCHER_TOKEN_FILE ||
        "/var/lib/secondbrain/lanzador-token",
      "utf8",
    )
  ).trim();
  const endpoint = new URL(
    `/threads?status=${BUSY}`,
    process.env.SB_LAUNCHER_URL || "http://127.0.0.1:8092",
  );
  if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:")
    throw new Error();
  const deadline = Date.now() + wait;
  while (true) {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(5000, deadline - Date.now())),
      ),
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (!Array.isArray(body?.threads)) throw new Error();
    if (body.threads.length === 0) break;
    if (Date.now() >= deadline) throw new Error();
    await setTimeout(Math.min(poll, Math.max(1, deadline - Date.now())));
  }
} catch {
  console.error(
    "Lanzador pendiente: hay threads trabajando o no se pudo confirmar su estado. Reintentar al terminar.",
  );
  process.exitCode = 1;
}
