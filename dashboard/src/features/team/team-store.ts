import { useSyncExternalStore } from "react";
import { api, isDemo } from "../../core/store";
import { createTeamController } from "./team-controller";

/** `timeout` (ms) replaces the default for slow calls such as opening a pull request. */
export const teamApi = async (
  path: string,
  body?: unknown,
  timeout?: number,
) =>
  isDemo
    ? (await import("../sala/sala-demo")).apiDemo(path, body)
    : api(path, {
        ...(body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body) }),
        ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
export const teamController = createTeamController(teamApi);
export function useTeam() {
  return useSyncExternalStore(
    teamController.subscribe,
    teamController.getSnapshot,
  );
}
