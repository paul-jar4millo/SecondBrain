import { z } from "zod";
import { ItemId, Seq, ThreadId } from "./ids.ts";
import { ThreadEvent } from "./events.ts";
import { DeltaField, Item } from "./items.ts";
import { UserRequest } from "./requests.ts";
import { Thread } from "./thread.ts";

/** GET /threads/:id — everything needed to render a thread. */
export const ThreadSnapshot = z.object({
  thread: Thread,
  items: z.array(Item),
  requests: z.array(UserRequest),
  lastSeq: Seq,
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshot>;

/**
 * Messages on GET /threads/:id/stream. `event` carries the SSE id (seq) and
 * can be resumed with Last-Event-ID or ?after=; the others are ephemeral.
 */
export const StreamMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: ThreadEvent }),
  z.object({
    type: z.literal("item.delta"),
    threadId: ThreadId,
    itemId: ItemId,
    field: DeltaField,
    delta: z.string(),
    /** Last persisted seq when the delta was produced. */
    afterSeq: Seq,
  }),
  /** Current state of an item still in progress, sent after a replay. */
  z.object({
    type: z.literal("item.snapshot"),
    item: Item,
    afterSeq: Seq,
  }),
  /** The requested seq cannot be replayed: fetch the snapshot again. */
  z.object({
    type: z.literal("snapshot-required"),
    threadId: ThreadId,
    reason: z.string(),
  }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type StreamMessage = z.infer<typeof StreamMessage>;

/** Messages on GET /threads/stream (global feed by globalSeq). */
export const GlobalStreamMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: ThreadEvent }),
  z.object({ type: z.literal("snapshot-required"), reason: z.string() }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type GlobalStreamMessage = z.infer<typeof GlobalStreamMessage>;

/** Serialises one Server-Sent Events frame. */
export function formatSse(data: unknown, id?: number): string {
  const lines = JSON.stringify(data)
    .split("\n")
    .map((line) => `data: ${line}`);
  return `${id === undefined ? "" : `id: ${id}\n`}${lines.join("\n")}\n\n`;
}

/** Parses a resume position from Last-Event-ID or ?after=. */
export function resumePosition(
  lastEventId: string | null | undefined,
  after: string | null | undefined,
): number {
  for (const raw of [lastEventId, after]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
}
