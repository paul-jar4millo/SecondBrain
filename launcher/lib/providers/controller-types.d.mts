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

export type ProviderStepStatus = "pending" | "in_progress" | "completed";
export type ProviderItemStatus = "in-progress" | "completed" | "failed";

export interface ProviderFileDiff {
  path: string;
  oldPath?: string;
  change: "add" | "modify" | "delete" | "rename";
  patch: string;
  additions: number;
  deletions: number;
}

export interface ProviderRateLimitWindow {
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
  status?: "allowed" | "warning" | "rejected";
}

/**
 * Rich events beyond messages and tools. Ids are stable per provider item:
 * a later event with the same id updates the same item. `parentId` ties an
 * event to a subagent (Claude parent_tool_use_id).
 */
export type ProviderEvent =
  | { type: "reasoning"; id: string; text: string; delta?: boolean }
  | {
      type: "plan";
      id: string;
      explanation?: string;
      steps: { text: string; status: ProviderStepStatus }[];
    }
  | {
      type: "todo_list";
      id: string;
      todos: { text: string; status: ProviderStepStatus }[];
    }
  | {
      type: "file_change";
      id: string;
      diffs: ProviderFileDiff[];
      status: ProviderItemStatus;
    }
  | { type: "turn_diff"; diffs: ProviderFileDiff[] }
  | {
      type: "command";
      id: string;
      command: string;
      cwd?: string;
      output?: string;
      outputDelta?: string;
      exitCode?: number | null;
      durationMs?: number;
      status: ProviderItemStatus;
    }
  | {
      type: "subagent";
      id: string;
      name: string;
      description?: string;
      prompt?: string;
      result?: string;
      activity?: string;
      status: ProviderItemStatus;
    }
  | {
      type: "usage";
      tokens: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
        costUsd?: number;
      };
    }
  | { type: "rate_limits"; windows: ProviderRateLimitWindow[] }
  | { type: "mode"; mode: string };

export interface ProviderTurnContext extends ProfileContext, McpContext {
  /** Rich events for the thread engine; optional for legacy callers. */
  emit?(event: ProviderEvent): void;
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
