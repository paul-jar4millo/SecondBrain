import { z } from "zod";
import { AgentRef } from "./agents.ts";
import {
  HandoffId,
  ItemId,
  RequestId,
  ReviewId,
  Seq,
  ThreadId,
  Timestamp,
  TurnId,
} from "./ids.ts";
import { RateLimitWindow, TokenUsage } from "./usage.ts";

export const ItemStatus = z.enum(["in-progress", "completed", "failed"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

const base = {
  id: ItemId,
  threadId: ThreadId,
  turnId: TurnId.nullable(),
  /** Sequence of the event that created the item. */
  seq: Seq,
  status: ItemStatus,
  agent: AgentRef.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const DeliveryMode = z.enum(["send", "steer", "queue"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const Attachment = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  mime: z.string().optional(),
  size: z.int().min(0).optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const StepStatus = z.enum(["pending", "in_progress", "completed"]);

export const FileDiff = z.object({
  path: z.string().min(1),
  oldPath: z.string().optional(),
  change: z.enum(["add", "modify", "delete", "rename"]),
  patch: z.string(),
  additions: z.int().min(0),
  deletions: z.int().min(0),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const ReviewFinding = z.object({
  file: z.string().optional(),
  line: z.int().min(1).optional(),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  text: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** Hard data the system gathers for a hand-off; the agent adds a narrative. */
export const HandoffBrief = z.object({
  diffstat: z.array(
    z.object({
      path: z.string(),
      additions: z.int().min(0),
      deletions: z.int().min(0),
    }),
  ),
  commands: z.array(
    z.object({ command: z.string(), exitCode: z.int().nullable() }),
  ),
  failedTests: z.array(z.string()),
  errors: z.array(z.string()),
  files: z.array(z.string()),
});
export type HandoffBrief = z.infer<typeof HandoffBrief>;

export const UserMessageItem = z.object({
  ...base,
  kind: z.literal("user_message"),
  text: z.string(),
  delivery: DeliveryMode,
  attachments: z.array(Attachment),
});
export const AssistantMessageItem = z.object({
  ...base,
  kind: z.literal("assistant_message"),
  text: z.string(),
});
export const ReasoningItem = z.object({
  ...base,
  kind: z.literal("reasoning"),
  text: z.string(),
});
export const PlanItem = z.object({
  ...base,
  kind: z.literal("plan"),
  explanation: z.string().optional(),
  steps: z.array(z.object({ text: z.string(), status: StepStatus })),
});
export const TodoListItem = z.object({
  ...base,
  kind: z.literal("todo_list"),
  todos: z.array(z.object({ text: z.string(), status: StepStatus })),
});
export const FileChangeItem = z.object({
  ...base,
  kind: z.literal("file_change"),
  diffs: z.array(FileDiff),
});
export const CommandItem = z.object({
  ...base,
  kind: z.literal("command"),
  command: z.string(),
  cwd: z.string().optional(),
  output: z.string(),
  exitCode: z.int().nullable(),
  durationMs: z.int().min(0).optional(),
});
export const ToolCallItem = z.object({
  ...base,
  kind: z.literal("tool_call"),
  name: z.string().min(1),
  server: z.string().optional(),
  input: z.unknown(),
  output: z.string().optional(),
  error: z.string().optional(),
});
export const UserRequestItem = z.object({
  ...base,
  kind: z.literal("user_request"),
  requestId: RequestId,
});
export const SubagentItem = z.object({
  ...base,
  kind: z.literal("subagent"),
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  result: z.string().optional(),
});
export const HandoffItem = z.object({
  ...base,
  kind: z.literal("handoff"),
  handoffId: HandoffId,
  fromStage: z.int().min(0),
  toStage: z.int().min(0),
  narrative: z.string(),
  openItems: z.array(z.string()),
  brief: HandoffBrief,
});
export const ReviewItem = z.object({
  ...base,
  kind: z.literal("review"),
  reviewId: ReviewId,
  round: z.int().min(1),
  verdict: z.enum(["approved", "changes-requested", "comment"]),
  summary: z.string(),
  findings: z.array(ReviewFinding),
});
export const NoticeItem = z.object({
  ...base,
  kind: z.literal("notice"),
  level: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  text: z.string(),
});
export const UsageItem = z.object({
  ...base,
  kind: z.literal("usage"),
  tokens: TokenUsage,
  rateLimits: z.array(RateLimitWindow),
});

export const Item = z.discriminatedUnion("kind", [
  UserMessageItem,
  AssistantMessageItem,
  ReasoningItem,
  PlanItem,
  TodoListItem,
  FileChangeItem,
  CommandItem,
  ToolCallItem,
  UserRequestItem,
  SubagentItem,
  HandoffItem,
  ReviewItem,
  NoticeItem,
  UsageItem,
]);
export type Item = z.infer<typeof Item>;
export type ItemKind = Item["kind"];
export type ItemOf<K extends ItemKind> = Extract<Item, { kind: K }>;

export const ITEM_KINDS = [
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "todo_list",
  "file_change",
  "command",
  "tool_call",
  "user_request",
  "subagent",
  "handoff",
  "review",
  "notice",
  "usage",
] as const satisfies readonly ItemKind[];

/** Item fields that streaming deltas append to. */
export const DeltaField = z.enum(["text", "output"]);
export type DeltaField = z.infer<typeof DeltaField>;
