import type { createToolCatalogStore } from "./tool-catalog.mjs";
import type { openWorkspaces } from "./workspaces.mjs";
import type { createModelCatalog } from "./models.mjs";

type ToolCatalog = Awaited<ReturnType<typeof createToolCatalogStore>>;
type WorkspaceRegistry = Awaited<ReturnType<typeof openWorkspaces>>;

export interface LauncherServerOptions {
  threads?: {
    http: {
      handle(
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
        url: URL,
      ): Promise<boolean>;
    };
  } | null;
  toolCatalog?: ToolCatalog | null;
  catalogo?: ReturnType<typeof createModelCatalog>;
  uso?: () => Promise<unknown>;
  proyectos?: Record<string, string>;
  espacios?: WorkspaceRegistry;
  controlHash: string;
  registrar?: (line: string) => void;
}

export type LauncherRequestBody = Partial<
  Parameters<WorkspaceRegistry["link"]>[0] &
    Parameters<ToolCatalog["updateProfile"]>[1] &
    Parameters<ToolCatalog["resolveSkillsForTask"]>[0]
> & {
  repositorio?: string | null;
  optInProbe?: boolean;
  profileId?: string;
  billingAuthorized?: unknown;
  verifiedOperatorBillingGrant?: unknown;
  cwd?: string;
};
