import type { crearAcciones } from "./acciones.mjs";
import type { createToolCatalogStore } from "./catalogo-herramientas.mjs";
import type { crearEjecutor } from "./ejecucion.mjs";
import type { abrirEquipos } from "./equipos.mjs";
import type { abrirEspacios } from "./espacios.mjs";
import type { crearItems } from "./items.mjs";
import type { crearCatalogo } from "./modelos.mjs";
import type { ConversationAnswer } from "./provider-conversation-types.mjs";
import type { createProviderConversations } from "./provider-conversations.mjs";
import type { SessionRegistry } from "./session-types.d.ts";
import type { DeliveryInput, IntegrationOptions } from "./team-types.d.ts";
import type { ExecutionRequest, TerminalInput } from "./types.d.ts";

type ToolCatalog = Awaited<ReturnType<typeof createToolCatalogStore>>;
type WorkspaceRegistry = Awaited<ReturnType<typeof abrirEspacios>>;

export interface LauncherServerOptions {
  registro: SessionRegistry;
  ejecutor: ReturnType<typeof crearEjecutor>;
  conversations?: ReturnType<typeof createProviderConversations> | null;
  toolCatalog?: ToolCatalog | null;
  catalogo?: ReturnType<typeof crearCatalogo>;
  uso?: () => Promise<unknown>;
  items?: ReturnType<typeof crearItems>;
  acciones?: ReturnType<typeof crearAcciones>;
  equipos?: Awaited<ReturnType<typeof abrirEquipos>>;
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
