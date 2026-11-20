import { z } from "zod";
import { AgentRef } from "./agents.ts";
import { RequestId, ThreadId, Timestamp, TurnId } from "./ids.ts";
import { Item } from "./items.ts";
import { RequestAnswer, RequestOrigin, UserRequest } from "./requests.ts";
import { Thread, ThreadPatch } from "./thread.ts";

const envelope = {
  threadId: ThreadId,
  /** Position in the thread's log, from 1 without gaps. */
  seq: z.int().min(1),
  /** Position in the global feed, unique across threads. */
  globalSeq: z.int().min(1),
  at: Timestamp,
};

export const TurnOutcome = z.enum(["completed", "interrupted", "failed"]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const ThreadCreatedEvent = z.object({
  ...envelope,
  type: z.literal("thread.created"),
  thread: Thread,
});
export const ThreadUpdatedEvent = z.object({
  ...envelope,
  type: z.literal("thread.updated"),
  patch: ThreadPatch,
});
export const TurnStartedEvent = z.object({
  ...envelope,
  type: z.literal("turn.started"),
  turnId: TurnId,
  agent: AgentRef,
  stageIndex: z.int().min(0),
});
export const TurnCompletedEvent = z.object({
  ...envelope,
  type: z.literal("turn.completed"),
  turnId: TurnId,
  outcome: TurnOutcome,
  error: z.string().optional(),
});
export const ItemStartedEvent = z.object({
  ...envelope,
  type: z.literal("item.started"),
  item: Item,
});
export const ItemUpdatedEvent = z.object({
  ...envelope,
  type: z.literal("item.updated"),
  item: Item,
});
export const ItemCompletedEvent = z.object({
  ...envelope,
  type: z.literal("item.completed"),
  item: Item,
});
export const RequestOpenedEvent = z.object({
  ...envelope,
  type: z.literal("request.opened"),
  request: UserRequest,
});
export const RequestResolvedEvent = z.object({
  ...envelope,
  type: z.literal("request.resolved"),
  requestId: RequestId,
  status: z.enum(["answered", "cancelled", "expired"]),
  answer: RequestAnswer.nullable(),
  origin: RequestOrigin.nullable(),
});

/** Persisted events. Streaming deltas are not events (see stream.ts). */
export const ThreadEvent = z.discriminatedUnion("type", [
  ThreadCreatedEvent,
  ThreadUpdatedEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  RequestOpenedEvent,
  RequestResolvedEvent,
]);
export type ThreadEvent = z.infer<typeof ThreadEvent>;
export type ThreadEventType = ThreadEvent["type"];

export const THREAD_EVENT_TYPES = [
  "thread.created",
  "thread.updated",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.updated",
  "item.completed",
  "request.opened",
  "request.resolved",
] as const satisfies readonly ThreadEventType[];

type WithoutPosition<E> = E extends unknown
  ? Omit<E, "seq" | "globalSeq">
  : never;

/** An event before the store assigns its positions. */
export type NewThreadEvent = WithoutPosition<ThreadEvent>;
