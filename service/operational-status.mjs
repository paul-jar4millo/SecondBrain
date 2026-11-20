import { readFile } from "node:fs/promises";

/** @param {string} file */
async function bounded(file) {
  try {
    const value = await readFile(file, "utf8");
    return value.length <= 8192 ? value : null;
  } catch {
    return null;
  }
}
/** @param {{ stateFile?: string, revisionFile?: string, launcherPinFile?: string, runtimeLauncherFile?: string, now?: number }} options */
export async function operationalStatus({
  stateFile,
  revisionFile,
  launcherPinFile,
  runtimeLauncherFile,
  now = Date.now(),
}) {
  const [stateText, revisionText, pinText, runtimeText] = await Promise.all(
    [stateFile, revisionFile, launcherPinFile, runtimeLauncherFile].map(
      (file) => (file ? bounded(file) : null),
    ),
  );
  const revision = /^[a-f0-9]{40}$/.test(revisionText?.trim())
    ? revisionText.trim()
    : null;
  const launcherText = (pinText || runtimeText)?.trim();
  const launcherRevision = /^\/opt\/secondbrain\/releases\/[a-f0-9]{40}$/.test(
    launcherText,
  )
    ? launcherText.split("/").at(-1)
    : null;
  let state;
  try {
    state = stateText ? JSON.parse(stateText) : null;
  } catch {
    state = null;
  }
  const time = Date.parse(state?.lastSuccess);
  const errorTime = Date.parse(state?.lastErrorAt);
  let backupStatus =
    stateText && !state
      ? "invalid"
      : !Number.isFinite(time)
        ? "never"
        : time > now + 300000
          ? "invalid"
          : now - time > 26 * 3600000
            ? "stale"
            : "ok";
  if (
    Number.isFinite(errorTime) &&
    (!Number.isFinite(time) || errorTime >= time)
  )
    backupStatus = "failed";
  const deployment = {
    revision,
    launcherRevision,
    pending:
      revision && launcherRevision ? revision !== launcherRevision : null,
  };
  return {
    status:
      backupStatus === "ok" && deployment.pending === false ? "ok" : "degraded",
    backup: {
      status: backupStatus,
      lastSuccess: Number.isFinite(time) ? new Date(time).toISOString() : null,
      lastRestore: Number.isFinite(Date.parse(state?.lastRestore))
        ? new Date(state.lastRestore).toISOString()
        : null,
    },
    deployment,
  };
}
