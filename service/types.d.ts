import type { IncomingMessage } from "node:http";

export type HttpRequest = IncomingMessage & {
  socket: IncomingMessage["socket"] & { encrypted?: boolean };
  headers: IncomingMessage["headers"] &
    Partial<Record<"x-sb-agente" | "x-sb-cliente" | "x-sb-sesion", string>>;
};

export type HttpLogRecord =
  | {
      event: "http";
      requestId: string;
      method?: string;
      route: string;
      status: number;
      durationMs: number;
    }
  | {
      event: "http.error";
      requestId?: string;
      type: string;
      message: string;
      stack?: string;
    }
  | {
      event: "http.stream";
      requestId?: string | number | string[];
      type: string;
      message: string;
    };

export interface ApplicationOptions {
  vaultRoot?: string;
  dataDirectory?: string;
  sharedDirectory?: string;
  staticRoot?: string;
  production?: boolean;
  auth?: boolean;
  authLimit?: number;
  serveDashboard?: boolean;
  mundoPaquete?: string;
  agentes?: {
    brainToken?: string;
    brainTokenFile?: string;
    token?: string;
    tokenFile?: string;
  };
  lanzador?: Parameters<typeof import("./lanzador.mjs").createLanzador>[1];
  mcpRemoto?: Pick<
    Parameters<typeof import("./mcp-remoto.mjs").crearMcpRemoto>[0],
    "now"
  >;
  aprobaciones?: Parameters<
    typeof import("./aprobaciones.mjs").crearColaAprobaciones
  >[1];
  workOrders?: Parameters<
    typeof import("./work-orders.mjs").createWorkOrderStore
  >[1];
  userRequests?: Parameters<
    typeof import("./user-requests.mjs").createUserRequestStore
  >[1];
  effects?: Partial<
    Parameters<typeof import("./effects-executor.mjs").createEffectsExecutor>[1]
  >;
  operatorBillingPolicy?: { allowBilledApi?: boolean };
  operatorToolPolicy?: { allowedMcps?: string[]; allowedOperations?: string[] };
  logger?: (record: HttpLogRecord) => void;
}

export interface LauncherSessionSummary {
  id: string;
  motor: string;
  workOrderId?: string | null;
  mensajes?: unknown;
  resultado?: unknown;
}

export interface Credentials {
  username?: unknown;
  password?: unknown;
  code?: unknown;
}

export interface AuthOptions {
  production?: boolean;
  trustedProxy?: string;
  limit?: number;
  enabled?: boolean;
  roomToken?: string;
}

export interface AuthState {
  sessions: Record<string, { expires: number }>;
  csrfSecret: string;
  username?: string;
  passwordHash?: string;
  salt?: string;
  totpSecret?: string;
  pendingTotpSecret?: string;
  lastTotpStep?: number;
  recoveryDigests?: string[];
}

export interface CapabilityOptions {
  sessionId?: string | null;
  parentSessionId?: string | null;
  workOrderId?: string | null;
  memberId?: string | null;
  actor?: string | null;
  profileId?: string;
  allowedMcps?: string[];
  allowedOperations?: string[];
  allowedEffectCategories?: string[];
  allowBilledApi?: boolean;
  canDelegateBeyondSelf?: boolean;
  depth?: number;
  maxDepth?: number;
  ttlMs?: number;
}

export interface Capability extends Required<Omit<CapabilityOptions, "ttlMs">> {
  id: string;
  digest: string;
  kind: "session_capability";
  allowExternalWriteSecrets: false;
  createdAt: string;
  expiresAt: number | null;
  revoked: boolean;
}

export type ScopedRecord = Pick<
  CapabilityOptions,
  "sessionId" | "memberId" | "workOrderId"
>;

export type ToolProfile = Pick<
  Capability,
  | "id"
  | "allowedMcps"
  | "allowedOperations"
  | "allowedEffectCategories"
  | "allowBilledApi"
  | "allowExternalWriteSecrets"
  | "canDelegateBeyondSelf"
>;
