import type {
  OperationFields,
  UserRequestInput,
  UserRequestReceipt,
} from "./user-request-types.d.ts";
import type { createUserRequestStore } from "./user-requests.mjs";

type EffectOperation = {
  category: string;
  action: string;
  recipient: string;
  content: string | null;
  contentHash: string;
  changes: unknown;
  cost: string;
  scope: string;
};

export interface EffectInput
  extends
    OperationFields,
    Pick<
      UserRequestInput,
      | "requestId"
      | "workOrderId"
      | "sessionId"
      | "memberId"
      | "content"
      | "title"
      | "prompt"
      | "ttlMs"
      | "nativeRequestId"
      | "nativeSessionId"
      | "nativeTurnId"
    > {
  id?: string | null;
  category?: unknown;
  toolProfileId?: unknown;
  fromAgent?: boolean;
  billingApprovalId?: string | null;
  allowedCategoriesOverride?: string[];
}

export interface EffectExecutionReceipt {
  requestId: string;
  effectId: string;
  approvalId: string | null;
  approvalRequestId?: string;
  operationFingerprint: string;
  category: string;
  action: string;
  recipient: string;
  status: string;
  outcome?: unknown;
  reconciled?: boolean;
  note?: string;
  by: string;
  ts: string;
}

export interface Effect extends EffectOperation {
  payloadVersion: number;
  id: string;
  prepareRequestId: string | null;
  billingApprovalId: string | null;
  operationFingerprint: string;
  workOrderId: string | null;
  sessionId: string | null;
  memberId: string | null;
  toolProfileId: string;
  approvalId: string | null;
  status: string;
  expiresAt?: string | null;
  executionReceipt: EffectExecutionReceipt | null;
  pendingExecutionRequestId: string | null;
  lastError: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EffectJournalRecord {
  op: "effect.put";
  effect: Effect;
}

export interface EffectExecutorOptions {
  userRequests: Awaited<ReturnType<typeof createUserRequestStore>>;
  externalRunner?:
    | ((
        operation: EffectOperation & {
          effectId: string;
          requestId: string;
          approvalReceipt: UserRequestReceipt;
        },
      ) => Promise<unknown> | unknown)
    | null;
  operatorBillingPolicy?: { allowBilledApi?: boolean };
  maxContentLength?: number;
  clock?: () => number;
  onChange?: () => void;
}
