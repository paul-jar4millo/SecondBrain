import { z } from "zod";
import { RequestId, ThreadId, Timestamp } from "./ids.ts";

/** Why a thread is waiting for the owner. */
export const InboxReason = z.enum([
  "request",
  "needs-decision",
  "ready-for-review",
  "failed",
  "handoff",
]);
export type InboxReason = z.infer<typeof InboxReason>;

export const InboxEntry = z.object({
  threadId: ThreadId,
  threadTitle: z.string(),
  reason: InboxReason,
  requestId: RequestId.nullable(),
  summary: z.string(),
  since: Timestamp,
});
export type InboxEntry = z.infer<typeof InboxEntry>;
