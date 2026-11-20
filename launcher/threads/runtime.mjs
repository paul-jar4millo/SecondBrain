// Wires the thread system into the launcher: SQLite store, engine,
// scheduler, workspaces, provider context and HTTP routes.
import path from "node:path";
import { createProcessTools } from "../execution/process-tools.mjs";
import { CONTROLLER_FACTORIES } from "../provider-controllers.mjs";
import { createClosing } from "./engine/closing.ts";
import { createScheduler } from "./engine/scheduler.ts";
import { createThreadEngine } from "./engine/thread-engine.ts";
import { createThreadWorkspaces } from "./engine/workspace.ts";
import { createThreadsHttp } from "./http/routes.ts";
import { createProviderContextFactory } from "./provider-context.mjs";
import { openStore } from "./store/event-log.ts";

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   dataDir: string,
 *   projects: Record<string, string>,
 *   git: import("./engine/checkpoints.ts").GitRun,
 *   gh?: import("./engine/checkpoints.ts").GitRun,
 *   maxActive: number,
 *   toolCatalog?: { getProfile(id: string): any } | null,
 *   controllers?: Record<string, () => import("./engine/thread-engine.ts").ProviderController>,
 *   context?: import("./engine/thread-engine.ts").AgentContextFactory,
 * }} options
 */
export function openThreads({
  env,
  dataDir,
  projects,
  git,
  gh,
  maxActive,
  toolCatalog = null,
  controllers = /** @type {any} */ (CONTROLLER_FACTORIES),
  context,
}) {
  const store = openStore(path.join(dataDir, "threads.sqlite"));
  const tools = createProcessTools(
    /** @type {any} */ ({ env, proyectos: projects, registro: {} }),
  );
  const engine = createThreadEngine({
    store,
    git,
    scheduler: createScheduler(maxActive),
    workspaces: createThreadWorkspaces({
      git,
      projects,
      worktreesDir: path.join(dataDir, "threads", "worktrees"),
      scratchDir: path.join(dataDir, "threads", "scratch"),
      npmCacheDir: path.join(dataDir, "threads", "npm-cache"),
    }),
    context:
      context ??
      createProviderContextFactory({
        env,
        sanitizeChildEnv: tools.sanitizeChildEnv,
        acpGeminiDirFor: tools.acpGeminiDirFor,
        toolCatalog,
        tokenDir: path.join(dataDir, "threads", "tokens"),
      }),
    controllers,
    ...(gh ? { closing: createClosing({ git, gh }) } : {}),
  });
  engine.recover();
  const http = createThreadsHttp({ engine, store });
  return {
    store,
    engine,
    http,
    /** Closes the database at once; controllers stop in the background. */
    close() {
      const stopping = engine.shutdown();
      store.close();
      return stopping;
    },
  };
}
