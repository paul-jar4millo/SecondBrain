import type {
  ProviderChild,
  RpcWriteAcknowledgment,
} from "../../provider-rpc.mjs";
import type {
  ProfileContext,
  ProviderAttachment,
  McpContext,
  WorkspaceArtifact,
} from "./shared.mjs";

export interface ProviderSession {
  id?: string;
  motor?: string;
  modelo?: string | null;
  esfuerzo?: string | null;
  conversacionId?: string | null;
}

export interface ProviderControl {
  supportsSteer: boolean;
  connectionId: string;
  pid: number | null;
  steer?: (
    text: string,
    attachments?: ProviderAttachment[],
  ) => Promise<unknown>;
}

export interface ProviderRequestTransport {
  connectionId: string;
  writeAck?: Promise<RpcWriteAcknowledgment>;
  callbackAck?: Promise<{ callbackReturned: boolean }>;
  transportMode?: "sdk_callback_return";
  transportObservable?: boolean;
  isConnectionAlive?: () => boolean;
}

export interface ProviderAnswer {
  decision?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ProviderTurnContext extends ProfileContext, McpContext {
  turnId: string;
  session: ProviderSession;
  cwd: string;
  prompt: string;
  attachments?: ProviderAttachment[];
  operatorEnv?: NodeJS.ProcessEnv;
  interruptKillGraceMs?: number;
  spawn(
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv | undefined,
  ): ProviderChild;
  onAbort(handler: () => void): void;
  onControl?(control: ProviderControl): void;
  onSkillsObserved?(observation: { source: string; names: string[] }): unknown;
  invalidateConnection?(connectionId: string, reason: string): void;
  nativeId(id: string): unknown;
  message(id: string, value: string): void;
  delta(id: string, value: string, ephemeral?: boolean): void;
  tool(
    id: string,
    value: {
      nombre?: string;
      resumen?: string;
      resultado?: string;
      estado: "pendiente" | "ok" | "error";
    },
  ): void;
  artifact?(artifact: WorkspaceArtifact): unknown;
  ask(
    id: string,
    request: Record<string, unknown>,
    transport: ProviderRequestTransport,
  ): Promise<ProviderAnswer>;
}

export interface ProviderTurnState<Context extends ProviderTurnContext> {
  ctx: Context;
  connectionId: string;
  settled: boolean;
  pendingWork: Promise<unknown>[];
  publishedArtifactKeys: Set<string>;
}
