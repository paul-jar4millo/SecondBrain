// After a deploy an open tab still asks for the previous build's chunks, which no longer
// exist. One reload fetches the new build; a second failure within a minute is a real
// error and must be shown instead of looping.
const KEY = "sb-reloaded-at";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function reloadForNewVersion(
  storage: Storage = sessionStorage,
  reload: () => void = () => location.reload(),
  now = Date.now(),
): boolean {
  let last: string | null;
  try {
    last = storage.getItem(KEY);
  } catch {
    // Storage blocked: without a guard, refuse rather than risk a loop.
    return false;
  }
  if (last !== null && now - Number(last) < 60_000) return false;
  try {
    storage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

export const isStaleChunk = (error: unknown) =>
  /dynamically imported module|Importing a module script failed/i.test(
    String((error as Error)?.message ?? error),
  );
