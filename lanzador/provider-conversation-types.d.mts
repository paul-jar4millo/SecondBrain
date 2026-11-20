import type {
  ProviderAnswer,
  ProviderControl,
  ProviderRequestTransport,
  ProviderSession,
  ProviderTurnContext,
} from "./lib/providers/controller-types.mjs";
import type {
  ProviderAttachment,
  WorkspaceArtifact,
} from "./lib/providers/shared.mjs";

export type MessageDeliveryStatus =
  | "recibido"
  | "en_cola"
  | "entregado"
  | "confirmado_proveedor"
  | "fallido"
  | "entrega_incierta";

export type RequestDeliveryStatus =
  | "respuesta_recibida"
  | "entregando"
  | "entregada"
  | "confirmada"
  | "entrega_incierta";

export type NativeCallbackStatus =
  "open" | "expired" | "responded" | "interrupted" | "closed_by_turn";

export interface ConversationItem {
  id: string;
  ts: string;
  tipo?: "usuario" | "asistente" | "herramienta";
  texto?: string;
  ephemeral?: boolean;
  mode?: "steer";
  attachments?: ProviderAttachment[];
  herramienta?: Parameters<ProviderTurnContext["tool"]>[1];
}

export interface ConversationEventInput {
  id?: string;
  turnId?: string | null;
  nativeItemId?: string | null;
  correlationId?: string | null;
  sourceId?: string;
  type: string;
  payload?: unknown;
}

export interface ConversationEvent extends ConversationEventInput {
  id: string;
  sequence: number;
  sessionId: string;
  timestamp: string;
  payloadVersion: number;
}

export interface ConversationConnection {
  status: "active" | "idle" | "closed" | "evicted";
  pid: number | null;
  connectionId: string;
  reason?: string;
  updatedAt: string;
}

export interface ConversationCommand {
  id: string;
  clientMessageId: string;
  mode: "send" | "queue" | "steer";
  text: string;
  attachments: ProviderAttachment[];
  deliveryStatus: MessageDeliveryStatus;
  turnId: string | null;
  error: string | null;
  cancelled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedConversationMessage {
  commandId: string;
  clientMessageId: string;
  text: string;
  attachments: ProviderAttachment[];
  deliveryStatus: MessageDeliveryStatus;
  createdAt: string;
}

export interface ConversationAnswer {
  answers?: Record<string, unknown>;
  decision?: string;
  content?: unknown;
}

export interface ConversationPrompt extends Record<string, unknown> {
  kind: "approval" | "question";
  choices?: string[];
  questions?: Array<{ id: string }>;
  requestedSchema?: unknown;
  mode?: string;
}

export interface ConversationRequest extends ConversationPrompt {
  id: string;
  nativeId: string;
  turnId: string;
  connectionId: string;
  status: "pending" | "answered" | "expired";
  nativeCallbackStatus: NativeCallbackStatus;
  createdAt: string;
  productStatus?: RequestDeliveryStatus | "pendiente";
  requiresNewTurn?: boolean;
  answer?: ConversationAnswer;
  _claiming?: boolean;
}

export interface ConversationReceipt {
  requestId: string;
  responseId: string;
  turnId: string | null;
  connectionId: string | null;
  answer: ConversationAnswer;
  status: RequestDeliveryStatus;
  delivered: boolean;
  transportEvidence:
    | "rpc_write_flushed"
    | "callback_returned"
    | "callback_resolved"
    | "harness_progress"
    | null;
  transportMode?: "sdk_callback_return";
  transportObservable?: boolean;
  transportLimit?: string;
  callbackReturned?: boolean;
  harnessConfirmedAt?: string;
  error?: string;
}

export interface ConversationArtifact {
  id: string;
  artifactId: string;
  workOrderId: string | null;
  sessionId: string;
  authorId: string;
  fileRef: string;
  fileName: string;
  sha256: string;
  hash: string;
  bytesLength: number;
  mimeType: string;
  version: number;
  evidenceRefs: string[];
  summary: string;
  comment: string;
  immutable: boolean;
  verification: string;
  createdAt: string;
}

export interface ConversationState {
  seq: number;
  items: ConversationItem[];
  requests: ConversationRequest[];
  receipts: ConversationReceipt[];
  commands: ConversationCommand[];
  queue: QueuedConversationMessage[];
  artifacts: ConversationArtifact[];
  events: ConversationEvent[];
  eventSeq: number;
  lastTurnStatus: "interrupted" | "failed" | "completed" | null;
  connection: ConversationConnection | null;
  updatedAt?: string;
  observedSkills?: Array<{ source: string; names: string[]; ts: string }>;
}

export interface ConversationStore {
  state: ConversationState;
  filename: string;
  listeners: Set<() => void>;
  queue: Promise<void>;
}

export interface ConversationArtifactInput extends Partial<WorkspaceArtifact> {
  id?: string;
  content?: unknown;
  version?: number;
}

export interface ConversationTransport extends Omit<
  ProviderRequestTransport,
  "transportMode"
> {
  transportMode?: "sdk_callback_return" | "rpc_stdio" | "direct";
}

export interface ConversationContext extends Omit<
  ProviderTurnContext,
  "ask" | "artifact"
> {
  session: ConversationSession;
  connectionId: string;
  disableInheritedMcp: boolean;
  geminiDir?: string | null;
  acpLogFile?: string | null;
  settingSources?: import("@anthropic-ai/claude-agent-sdk").SettingSource[];
  verifiedBillingGrant: boolean;
  observeSkills: boolean;
  nextId(): number;
  event(input: ConversationEventInput): Promise<void>;
  expire(id: string): void;
  artifact(artifact: ConversationArtifactInput): Promise<void>;
  ask(
    id: string,
    request: ConversationPrompt,
    transport?: Partial<ConversationTransport>,
  ): ReturnType<ProviderTurnContext["ask"]>;
}

export interface ConversationSession extends ProviderSession {
  id: string;
  motor: string;
  memberId?: string;
  workOrderId?: string;
}

export interface RunConversationOptions extends Pick<
  ConversationContext,
  | "session"
  | "prompt"
  | "attachments"
  | "mcpServers"
  | "cwd"
  | "env"
  | "operatorEnv"
  | "geminiDir"
  | "acpLogFile"
  | "settingSources"
  | "interruptKillGraceMs"
  | "spawn"
> {
  onNativeId(id: string): unknown;
  onSkillsObserved?:
    ((observation: { source: string; names: string[] }) => unknown) | null;
  toolProfile?:
    (NonNullable<ProviderTurnContext["toolProfile"]> & { id?: string }) | null;
  disableInheritedMcp?: boolean;
  verifiedBillingGrant?: boolean;
  observeSkills?: boolean;
}

export interface SendConversationMessageOptions {
  clientMessageId?: string;
  text?: unknown;
  mode?: string;
  attachments?: ProviderAttachment[];
  online?: boolean;
  queueIfIdle?: boolean;
}

interface ConversationOutcome {
  status: string;
}

export interface ConversationController {
  connectionId: string;
  motor: string;
  createdAt: string;
  lastUsedAt: number;
  pid(): number | null;
  isAlive(): boolean;
  capabilities?(): Record<string, boolean>;
  shutdown(reason: string): Promise<void>;
  runTurn(ctx: ConversationContext): Promise<ConversationOutcome | void>;
}

export interface ConversationAdapter {
  (ctx: ConversationContext): Promise<ConversationOutcome | void>;
  createController?(): ConversationController;
}

export interface PendingConversationCallback {
  resolve(value: ProviderAnswer | PromiseLike<ProviderAnswer>): void;
  reject(reason: Error): void;
  nativeId: string;
  turnId: string;
  connectionId: string;
  writeAck: ConversationTransport["writeAck"] | null;
  callbackAck: ConversationTransport["callbackAck"] | null;
  transportMode: ConversationTransport["transportMode"];
  transportObservable: boolean;
  isConnectionAlive: ConversationTransport["isConnectionAlive"] | null;
  closed: boolean;
}

export interface ConversationJob {
  turnId: string;
  connectionId: string;
  callbacks: Map<string, PendingConversationCallback>;
  readonly control: Partial<ProviderControl>;
  invalidateCallbacks(reason: NativeCallbackStatus, message: string): void;
  invalidateConnection(connectionId: string, message: string): void;
  markDeliveredPendingConfirmation(): void;
  abort(): void;
}
