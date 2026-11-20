import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

// Read live state: a missing/corrupt journal must never authorize a restart.
try {
  const wait = Number(process.env.SB_DEPLOY_WAIT_MS ?? 900000);
  const poll = Number(process.env.SB_DEPLOY_POLL_MS ?? 5000);
  if (!Number.isFinite(wait) || wait < 0 || !Number.isFinite(poll) || poll <= 0)
    throw new Error();
  const token = (
    await readFile(
      process.env.LANZADOR_TOKEN_FILE || "/var/lib/secondbrain/lanzador-token",
      "utf8",
    )
  ).trim();
  const endpoint = new URL(
    "/estado",
    process.env.LANZADOR_URL || "http://127.0.0.1:8092",
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
    const sessions = await response.json();
    if (
      !Array.isArray(sessions) ||
      sessions.some((s) => !s || typeof s.estado !== "string")
    )
      throw new Error();
    if (
      !sessions.some(
        (s) => ["pendiente", "trabajando"].includes(s.estado) || s.interactiva,
      )
    )
      break;
    if (Date.now() >= deadline) throw new Error();
    await setTimeout(Math.min(poll, Math.max(1, deadline - Date.now())));
  }
} catch {
  console.error(
    "Lanzador pendiente: hay sesiones activas o no se pudo confirmar su estado. Reintentar al terminar.",
  );
  process.exitCode = 1;
}
