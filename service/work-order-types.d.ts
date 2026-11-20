export interface WorkOrderMemberInput {
  id?: string;
  characterId?: string;
  providerInstanceId?: string;
  engine?: string;
  motor?: string;
  model?: unknown;
  effort?: unknown;
  role?: unknown;
  responsibility?: unknown;
  coordinator?: unknown;
  toolProfileId?: string;
  assigned?: boolean;
}

export interface WorkOrderMember {
  id: string;
  characterId?: string;
  providerInstanceId: string;
  motor: string;
  engine: string;
  model: string;
  effort: string | null;
  role: string;
  responsibility: string;
  coordinator: boolean;
  toolProfileId: string;
  assigned: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  checked: boolean;
  evidenceRefs: string[];
}

export type AcceptanceCriterionInput = Partial<
  Pick<AcceptanceCriterion, "id">
> & {
  text?: unknown;
  checked?: unknown;
  evidenceRefs?: unknown;
};

export interface Recipient {
  scope: string;
  memberId?: string | null;
}

export interface Viewer {
  recipientScope?: string | null;
  memberId?: string | null;
}

export interface ScopedItem {
  visibility?: string | null;
  recipient?: Recipient | null;
  sourceId?: string | null;
}

export interface Artifact extends ScopedItem {
  id: string;
  workOrderId: string;
  sessionId: string | null;
  authorId: string;
  fileRef: string;
  fileName: string;
  hash: string;
  sha256: string;
  bytesLength: number;
  mimeType: string;
  version: number;
  summary: string;
  comment: string;
  immutable: boolean;
  evidenceRefs: string[];
  verification: string;
  createdAt: string;
}

export interface WorkOrderHandoff extends ScopedItem {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  teamRevision: number;
  decisions: string[];
  artifacts: string[];
  pending: string[];
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface WorkOrderCommand extends ScopedItem {
  id: string;
  workOrderId: string;
  clientMessageId: string;
  deliveryStatus: string;
  recipient: Recipient;
  mode: string;
  text: string;
  attachments: string[];
  createdAt: string;
  updatedAt: string;
  sequence?: number;
}

export interface WorkOrderManifest {
  manifestVersion: number;
  workOrderId: string;
  teamRevision: number;
  createdAt: string;
  projectId: string;
  objective: string;
  expectedOutcome: string;
  acceptanceCriteria: Pick<AcceptanceCriterion, "id" | "text">[];
  coordinatorId: string;
  team: WorkOrderMember[];
  sha256: string;
}

export interface WorkOrder {
  payloadVersion: number;
  id: string;
  code: string;
  title: string;
  projectId: string;
  objective: string;
  expectedOutcome: string;
  acceptanceCriteria: AcceptanceCriterion[];
  teamRevision: number;
  pendingTeamRevision: {
    teamRevision: number;
    previousTeamRevision: number;
    applyMode: "handoff" | "next_turn";
    registeredAt: string;
    preservesActiveManifest: true;
  } | null;
  team: WorkOrderMember[];
  manifest: WorkOrderManifest | null;
  tasks: (ScopedItem & Record<string, unknown>)[];
  artifacts: Artifact[];
  handoffs: WorkOrderHandoff[];
  commands: WorkOrderCommand[];
  status: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface WorkOrderInput {
  id?: string;
  code?: string;
  title?: unknown;
  projectId?: unknown;
  objective?: unknown;
  expectedOutcome?: unknown;
  team: WorkOrderMemberInput[];
  acceptanceCriteria: AcceptanceCriterionInput[];
}

export interface WorkEventPayload extends Record<string, unknown> {
  artifactId?: string;
  sessionId?: string;
  authorId?: string;
  fileRef?: string;
  fileName?: string;
  hash?: string;
  sha256?: string;
  bytesLength?: number;
  mimeType?: string;
  version?: number;
}

export interface WorkEventInput extends ScopedItem {
  id?: string;
  sessionId?: string | null;
  turnId?: string | null;
  nativeItemId?: string | null;
  correlationId?: string | null;
  provenance?: string | null;
  type: string;
  timestamp?: string | null;
  idempotencyKey?: string;
  payload?: WorkEventPayload;
}

export interface WorkEvent extends Required<
  Omit<WorkEventInput, "idempotencyKey">
> {
  sequence: number;
  workOrderId: string;
  payloadVersion: number;
  idempotencyKey?: string;
}

export type WorkOrderJournalRecord =
  | { op: "order.put"; order: WorkOrder; nextOrderNumber?: number }
  | { op: "event.append"; event: WorkEvent };
