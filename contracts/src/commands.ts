import { z } from "zod";
import { AgentRef } from "./agents.ts";
import { RequestId, ThreadId } from "./ids.ts";
import { Attachment, DeliveryMode } from "./items.ts";
import { RequestAnswer, RequestOrigin } from "./requests.ts";
import { Autonomy, CloseMode, ThreadKind } from "./thread.ts";

export const CreateThread = z
  .object({
    type: z.literal("CreateThread"),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000),
    kind: ThreadKind,
    /** Repository path for repo threads (a project of the agent workspace). */
    repoPath: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /** Workspace folder for scratch threads; a new one when omitted. */
    workspace: z.string().min(1).optional(),
    agent: AgentRef,
    autonomy: Autonomy.default("auto-worktree"),
    flowTemplateId: z.string().optional(),
    /** Agent per stage key, overriding the template defaults. */
    stageAgents: z.record(z.string(), AgentRef).optional(),
    parentId: ThreadId.optional(),
    attachments: z.array(Attachment).default([]),
  })
  .refine((c) => c.kind !== "repo" || c.repoPath !== undefined, {
    message: "Repo threads need repoPath",
    path: ["repoPath"],
  });

export const SendMessage = z.object({
  type: z.literal("SendMessage"),
  threadId: ThreadId,
  text: z.string().min(1).max(100_000),
  mode: DeliveryMode,
  attachments: z.array(Attachment).default([]),
  /** Switch agent or model for the next turn. */
  agent: AgentRef.optional(),
});

export const Interrupt = z.object({
  type: z.literal("Interrupt"),
  threadId: ThreadId,
});

export const AnswerRequest = z.object({
  type: z.literal("AnswerRequest"),
  threadId: ThreadId,
  requestId: RequestId,
  answer: RequestAnswer,
  origin: RequestOrigin,
});

export const CloseThread = z.object({
  type: z.literal("CloseThread"),
  threadId: ThreadId,
  mode: CloseMode,
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
});

export const Archive = z.object({
  type: z.literal("Archive"),
  threadId: ThreadId,
});

export const ApproveSubtask = z.object({
  type: z.literal("ApproveSubtask"),
  threadId: ThreadId,
  requestId: RequestId,
  approved: z.boolean(),
});

export const ThreadCommand = z.discriminatedUnion("type", [
  CreateThread,
  SendMessage,
  Interrupt,
  AnswerRequest,
  CloseThread,
  Archive,
  ApproveSubtask,
]);
export type ThreadCommand = z.infer<typeof ThreadCommand>;
export type ThreadCommandInput = z.input<typeof ThreadCommand>;
export type ThreadCommandType = ThreadCommand["type"];

export const THREAD_COMMAND_TYPES = [
  "CreateThread",
  "SendMessage",
  "Interrupt",
  "AnswerRequest",
  "CloseThread",
  "Archive",
  "ApproveSubtask",
] as const satisfies readonly ThreadCommandType[];

export const CommandError = z.object({
  code: z.enum([
    "not-found",
    "invalid-state",
    "conflict",
    "capacity",
    "forbidden",
    "invalid",
  ]),
  message: z.string(),
});
export type CommandError = z.infer<typeof CommandError>;
