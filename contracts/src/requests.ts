import { z } from "zod";
import { AgentRef } from "./agents.ts";
import { RequestId, ThreadId, Timestamp, TurnId } from "./ids.ts";
import { ReviewFinding } from "./items.ts";

/** Where an answer came from (the `origin` field of user requests). */
export const RequestOrigin = z.enum(["app", "discord", "push", "agent"]);
export type RequestOrigin = z.infer<typeof RequestOrigin>;

export const RequestKind = z.enum(["question", "approval", "form", "subtask"]);
export type RequestKind = z.infer<typeof RequestKind>;

export const RequestOption = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

export const RequestField = z.object({
  id: z.string().regex(/^[A-Za-z][\w-]{0,63}$/),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "select", "boolean"]),
  required: z.boolean(),
  options: z.array(RequestOption).optional(),
});

export const RequestAnswer = z
  .object({
    optionId: z.string().optional(),
    text: z.string().max(20_000).optional(),
    values: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    approved: z.boolean().optional(),
  })
  .refine((a) => Object.values(a).some((v) => v !== undefined), {
    message: "An answer needs at least one field",
  });
export type RequestAnswer = z.infer<typeof RequestAnswer>;

/** A question an agent asks the owner through MCP (thread_ask_user). */
export const AgentQuestion = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000).default(""),
  options: z.array(z.string().min(1).max(200)).max(20).optional(),
  fields: z.array(RequestField).min(1).max(20).optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestion>;

/** thread_handoff: the agent passes the thread to another stage of its flow. */
export const AgentHandoff = z.object({
  toStage: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  narrative: z.string().min(1).max(20_000),
  openItems: z.array(z.string().min(1).max(500)).max(50).default([]),
});
export type AgentHandoff = z.infer<typeof AgentHandoff>;

/** thread_report_review: the verdict of a review stage. */
export const AgentReview = z.object({
  verdict: z.enum(["approved", "changes-requested", "comment"]),
  summary: z.string().min(1).max(20_000),
  findings: z.array(ReviewFinding).max(100).default([]),
});
export type AgentReview = z.infer<typeof AgentReview>;

export const RequestStatus = z.enum([
  "open",
  "answered",
  "cancelled",
  "expired",
]);
export type RequestStatus = z.infer<typeof RequestStatus>;

/** thread_request_subtask: a child thread the owner must approve. */
export const AgentSubtask = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  agent: AgentRef.optional(),
  reason: z.string().max(5_000).optional(),
});
export type AgentSubtask = z.infer<typeof AgentSubtask>;

/** What a subtask request creates once approved. */
export const SubtaskDraft = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  agent: AgentRef,
});
export type SubtaskDraft = z.infer<typeof SubtaskDraft>;

export const UserRequest = z.object({
  id: RequestId,
  threadId: ThreadId,
  turnId: TurnId.nullable(),
  kind: RequestKind,
  title: z.string().min(1).max(300),
  body: z.string().max(20_000),
  options: z.array(RequestOption).optional(),
  fields: z.array(RequestField).optional(),
  subtask: SubtaskDraft.optional(),
  status: RequestStatus,
  answer: RequestAnswer.nullable(),
  origin: RequestOrigin.nullable(),
  createdAt: Timestamp,
  answeredAt: Timestamp.nullable(),
});
export type UserRequest = z.infer<typeof UserRequest>;
