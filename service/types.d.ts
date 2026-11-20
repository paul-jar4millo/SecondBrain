import type { IncomingMessage } from "node:http";

export type HttpRequest = IncomingMessage & {
  socket: IncomingMessage["socket"] & { encrypted?: boolean };
};

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
