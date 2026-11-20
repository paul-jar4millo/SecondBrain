import { z } from "zod";

/** Prefixes of every identifier the thread system creates. */
export const ID_PREFIXES = {
  thread: "thr",
  turn: "trn",
  item: "itm",
  request: "req",
  stage: "stg",
  handoff: "hof",
  review: "rev",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const idSchema = (kind: IdKind) =>
  z
    .string()
    .regex(
      new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-Za-z_-]{6,64}$`),
      `Expected a ${kind} id (${ID_PREFIXES[kind]}_…)`,
    );

export const ThreadId = idSchema("thread");
export const TurnId = idSchema("turn");
export const ItemId = idSchema("item");
export const RequestId = idSchema("request");
export const StageId = idSchema("stage");
export const HandoffId = idSchema("handoff");
export const ReviewId = idSchema("review");

/** New random id; works in Node and in browsers. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** ISO-8601 timestamp with offset. */
export const Timestamp = z.iso.datetime({ offset: true });

/** Sequence numbers start at 1; 0 means "nothing yet". */
export const Seq = z.int().min(0);
