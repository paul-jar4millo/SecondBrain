import path from "node:path";
import { stat } from "node:fs/promises";
import { send } from "../io.mjs";
import { operationalStatus } from "../../operational-status.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const systemRoutes = (ctx, req) => {
  const { appRoot, appVersion, auth, clients, root } = ctx;
  const { request, response } = req;
  return {
    "GET /health": async () => {
      const ready = await stat(path.join(root, "Home.md"))
        .then((s) => s.isFile())
        .catch(() => false);
      return send(response, ready ? 200 : 503, {
        status: ready ? "ready" : "unavailable",
        version: appVersion,
        storage: "obsidian-markdown",
        maintenance: await operationalStatus({
          stateFile: "/var/lib/secondbrain-ops/backup-status.json",
          revisionFile: path.join(appRoot, "REVISION"),
          launcherPinFile: "/etc/secondbrain/launcher-release",
          runtimeLauncherFile: "/run/secondbrain-launcher-release",
        }),
      });
    },
    "GET /events": async () => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      const heartbeat = setInterval(() => {
        if (!auth.authenticated(request)) {
          clearInterval(heartbeat);
          clients.delete(response);
          response.end();
        } else response.write(": heartbeat\n\n");
      }, 20000);
      heartbeat.unref();
      request.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
      return;
    },
  };
};
