import type { WorkEventInput } from "./work-order-types.d.ts";

export interface OperationFields {
  action?: unknown;
  recipient?: unknown;
  contentHash?: unknown;
  changes?: unknown;
  cost?: unknown;
  scope?: unknown;
}

export interface UserRequestInput extends OperationFields {
  id?: string;
  createRequestId?: string | null;
  requestId?: string | null;
  workOrderId?: string | null;
  sessionId?: string | null;
  memberId?: string | null;
  kind?: string;
  title?: unknown;
  prompt?: unknown;
  options?: unknown;
  allowFreeText?: boolean;
  ttlMs?: number | string;
  content?: unknown;
  nativeRequestId?: string | number | null;
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  nativeCallbackStatus?: string | null;
}

interface UserRequestReceiptBase {
  requestId: string;
  userRequestId: string;
  decision: string;
  by: string;
  origin: string;
  ts: string;
  operationFingerprint?: string | null;
}

export type UserRequestReceipt = UserRequestReceiptBase &
  (
    | {
        kind: "approval";
        decision: "aprobada" | "rechazada";
      }
    | {
        kind: "question";
        selectedOption: string | null;
        freeText: string | null;
        requiresNewTurn: boolean;
      }
  );

export interface UserRequest {
  payloadVersion: number;
  id: string;
  createRequestId: string | null;
  workOrderId: string | null;
  sessionId: string | null;
  memberId: string | null;
  kind: "approval" | "question";
  title: string;
  prompt: string;
  options: string[];
  allowFreeText: boolean;
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  expiresAtMs: number | null;
  requiresNewTurn: boolean;
  nativeRequestId: string | number | null;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  nativeCallbackStatus: string;
  action?: string;
  recipient?: string;
  contentHash?: string;
  changes?: unknown;
  cost?: string;
  scope?: string;
  content?: string | null;
  operationFingerprint?: string | null;
  deliveryNote?: string;
  response:
    | { approve: boolean }
    | { option: string | null; freeText: string | null; answer: string }
    | null;
  receipt: UserRequestReceipt | null;
}

export interface UserRequestStoreOptions {
  clock?: () => number;
  approvalTimeoutMs?: number;
  onChange?: () => void;
  onEvent?: (workOrderId: string, payload: WorkEventInput) => Promise<unknown>;
}

export interface UserRequestJournalRecord {
  op: "request.put";
  request: UserRequest;
}
