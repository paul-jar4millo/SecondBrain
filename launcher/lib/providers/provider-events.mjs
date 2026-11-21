// Normalisers shared by the provider controllers to emit rich events
// (ProviderEvent in controller-types.d.mts). The thread engine maps them to
// contract items (launcher/threads/engine/event-mapper.ts).

/** @typedef {import("./controller-types.mjs").ProviderStepStatus} ProviderStepStatus */
/** @typedef {import("./controller-types.mjs").ProviderFileDiff} ProviderFileDiff */
/** @typedef {import("./controller-types.mjs").ProviderRateLimitWindow} ProviderRateLimitWindow */

/**
 * Plan and todo statuses across providers ("inProgress", "in-progress",
 * "in_progress", "active", "done"...).
 * @param {unknown} status
 * @returns {ProviderStepStatus}
 */
export function stepStatus(status) {
  const value = String(status ?? "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  if (["completed", "complete", "done"].includes(value)) return "completed";
  if (["in_progress", "active", "running"].includes(value))
    return "in_progress";
  return "pending";
}

/**
 * Lines added and removed in a unified diff (headers excluded).
 * @param {string} patch
 */
export function diffStats(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Splits a multi-file unified diff (git or Codex turn diff) into one entry
 * per file.
 * @param {string} diff
 * @returns {ProviderFileDiff[]}
 */
export function splitUnifiedDiff(diff) {
  /** @type {ProviderFileDiff[]} */
  const files = [];
  /** @type {string[]} */
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    const patch = lines.join("\n");
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
    const minus = /^--- (?:a\/)?(.+)$/m.exec(patch)?.[1];
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)?.[1];
    const renameFrom = /^rename from (.+)$/m.exec(patch)?.[1];
    const renameTo = /^rename to (.+)$/m.exec(patch)?.[1];
    const isNew = /^new file mode/m.test(patch) || minus === "/dev/null";
    const isDeleted = /^deleted file mode/m.test(patch) || plus === "/dev/null";
    const path =
      renameTo ??
      (plus && plus !== "/dev/null" ? plus : undefined) ??
      header?.[2] ??
      minus ??
      "";
    /** @type {ProviderFileDiff} */
    const entry = {
      path,
      change: renameFrom
        ? "rename"
        : isNew
          ? "add"
          : isDeleted
            ? "delete"
            : "modify",
      patch,
      ...diffStats(patch),
    };
    if (renameFrom) entry.oldPath = renameFrom;
    if (isDeleted) entry.path = minus && minus !== "/dev/null" ? minus : path;
    if (entry.path) files.push(entry);
    lines = [];
  };
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("diff --git ")) flush();
    else if (
      line.startsWith("--- ") &&
      lines.length &&
      !lines[0]?.startsWith("diff --git ") &&
      lines.some((l) => l.startsWith("@@"))
    )
      flush();
    lines.push(line);
  }
  flush();
  return files;
}

/**
 * A unified diff from whole-file texts (ACP diff content): common leading and
 * trailing lines are kept as context, the middle becomes one hunk.
 * @param {string} path
 * @param {string | null} oldText null for a new file
 * @param {string} newText
 * @returns {ProviderFileDiff}
 */
export function patchFromTexts(path, oldText, newText) {
  const before = oldText === null ? [] : String(oldText).split("\n");
  const after = String(newText).split("\n");
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const patch =
    removed.length || added.length
      ? [
          `--- ${oldText === null ? "/dev/null" : `a/${path}`}`,
          `+++ b/${path}`,
          `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
          ...removed.map((line) => `-${line}`),
          ...added.map((line) => `+${line}`),
        ].join("\n")
      : "";
  return {
    path,
    change: oldText === null ? "add" : "modify",
    patch,
    additions: added.length,
    deletions: removed.length,
  };
}

/**
 * Epoch seconds or milliseconds, or an ISO string, to ISO; null otherwise.
 * @param {unknown} value
 */
export function isoTime(value) {
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

/**
 * Claude SDK rate_limit_event → window.
 * @param {{ status?: string, resetsAt?: number, rateLimitType?: string, utilization?: number } | undefined} info
 * @returns {ProviderRateLimitWindow | null}
 */
export function claudeRateLimit(info) {
  if (!info) return null;
  const utilization =
    typeof info.utilization === "number" ? info.utilization : null;
  return {
    window: info.rateLimitType || "unknown",
    usedPercent:
      utilization === null
        ? info.status === "rejected"
          ? 100
          : null
        : Math.max(
            0,
            Math.min(100, utilization <= 1 ? utilization * 100 : utilization),
          ),
    resetsAt: isoTime(info.resetsAt),
    status:
      info.status === "rejected"
        ? "rejected"
        : info.status === "allowed_warning"
          ? "warning"
          : "allowed",
  };
}

/**
 * Every window of a Claude rate_limit_event. The CLI reports the utilization
 * of each window under `unifiedWindows`; the top level only names the one
 * that decides the status and often has no utilization.
 * @param {{ status?: string, resetsAt?: number, rateLimitType?: string, utilization?: number, unifiedWindows?: Record<string, { status?: string, resetsAt?: number, utilization?: number }> } | undefined} info
 * @returns {ProviderRateLimitWindow[]}
 */
export function claudeRateLimits(info) {
  if (!info) return [];
  const unified = info.unifiedWindows;
  const windows =
    unified && typeof unified === "object"
      ? Object.entries(unified).map(([rateLimitType, window]) =>
          claudeRateLimit({ ...window, rateLimitType }),
        )
      : [claudeRateLimit(info)];
  return windows.filter(
    /** @returns {w is ProviderRateLimitWindow} */ (w) => w !== null,
  );
}

/**
 * Codex account/rateLimits/updated → windows.
 * @param {unknown} payload
 * @returns {ProviderRateLimitWindow[]}
 */
export function codexRateLimits(payload) {
  const limits = /** @type {Record<string, any>} */ (
    /** @type {any} */ (payload)?.rateLimits ?? payload ?? {}
  );
  /** @type {ProviderRateLimitWindow[]} */
  const windows = [];
  for (const key of ["primary", "secondary"]) {
    const limit = limits[key];
    if (!limit || typeof limit.usedPercent !== "number") continue;
    const minutes = Number(limit.windowDurationMins);
    windows.push({
      window:
        minutes === 300
          ? "five_hour"
          : minutes === 10080
            ? "seven_day"
            : Number.isFinite(minutes) && minutes > 0
              ? `${minutes}m`
              : key,
      usedPercent: Math.max(0, Math.min(100, limit.usedPercent)),
      resetsAt: isoTime(limit.resetsAt),
      status: limit.usedPercent >= 100 ? "rejected" : "allowed",
    });
  }
  return windows;
}
