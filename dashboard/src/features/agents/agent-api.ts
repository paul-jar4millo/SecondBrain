import { api, isDemo } from "../../core/store";

export const agentApi = (path: string, body?: unknown) =>
  isDemo
    ? import("../room/room-demo").then(({ apiDemo }) => apiDemo(path, body))
    : api(
        path,
        body === undefined
          ? undefined
          : { method: "POST", body: JSON.stringify(body) },
      );
