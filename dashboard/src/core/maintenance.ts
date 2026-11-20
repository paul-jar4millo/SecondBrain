/**
 * Off-host backup state as reported by GET /health. The backup runs outside
 * this server, so a failure there is only visible if the app shows it.
 */
export interface BackupAlert {
  status: "failed" | "stale" | "invalid";
  lastSuccess: string | null;
}

const ALERTS = new Set(["failed", "stale", "invalid"]);

/**
 * Returns the backup problem worth showing, or null. "never" is not one: it
 * means no off-host backup has been set up, which is a deployment choice.
 */
export function backupAlert(health: unknown): BackupAlert | null {
  const backup = (
    health as { maintenance?: { backup?: Record<string, unknown> } } | null
  )?.maintenance?.backup;
  const status = backup?.status;
  if (typeof status !== "string" || !ALERTS.has(status)) return null;
  const lastSuccess =
    typeof backup?.lastSuccess === "string" &&
    Number.isFinite(Date.parse(backup.lastSuccess))
      ? backup.lastSuccess
      : null;
  return { status: status as BackupAlert["status"], lastSuccess };
}

/** Never throws: an unreachable server is already shown as offline. */
export async function fetchBackupAlert(): Promise<BackupAlert | null> {
  try {
    // 503 still carries the maintenance block.
    const response = await fetch("/api/v1/health", {
      signal: AbortSignal.timeout(10_000),
    });
    return backupAlert(await response.json());
  } catch {
    return null;
  }
}
