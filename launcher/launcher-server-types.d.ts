import type { createActions } from "./actions.mjs";
import type { createToolCatalogStore } from "./tool-catalog.mjs";
import type { createExecutor } from "./executor.mjs";
import type { openTeams } from "./teams.mjs";
import type { openWorkspaces } from "./workspaces.mjs";
import type { createItems } from "./items.mjs";
import type { createModelCatalog } from "./models.mjs";
import type { ConversationAnswer } from "./provider-conversation-types.mjs";
import type { createProviderConversations } from "./provider-conversations.mjs";
import type { SessionRegistry } from "./session-types.d.ts";
import type { DeliveryInput, IntegrationOptions } from "./team-types.d.ts";
import type { ExecutionRequest, TerminalInput } from "./types.d.ts";

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
  registro: SessionRegistry;
  ejecutor: ReturnType<typeof createExecutor>;
  conversations?: ReturnType<typeof createProviderConversations> | null;
  toolCatalog?: ToolCatalog | null;
  catalogo?: ReturnType<typeof createModelCatalog>;
  uso?: () => Promise<unknown>;
  items?: ReturnType<typeof createItems>;
  acciones?: ReturnType<typeof createActions>;
  equipos?: Awaited<ReturnType<typeof openTeams>>;
  proyectos?: Record<string, string>;
  espacios?: WorkspaceRegistry;
  controlHash: string;
  hookHash: string;
  registrar?: (line: string) => void;
}

export type LauncherRequestBody = Partial<
  ExecutionRequest &
    TerminalInput &
    DeliveryInput &
    IntegrationOptions &
    ConversationAnswer &
    Parameters<WorkspaceRegistry["vincular"]>[0] &
    Parameters<ToolCatalog["updateProfile"]>[1] &
    Parameters<ToolCatalog["resolveSkillsForTask"]>[0]
> & {
  actor?: string;
  clientMessageId?: string;
  continuar?: string;
  herramienta?: string;
  mode?: string;
  n?: number;
  optInProbe?: boolean;
  para?: string;
  reason?: unknown;
  requestId?: string;
  responseId?: string;
  sesion?: string;
  text?: string;
  timeout?: number;
  verifiedOperatorBillingGrant?: boolean;
};
