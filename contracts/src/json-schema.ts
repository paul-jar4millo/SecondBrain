import { z } from "zod";
import { ThreadCommand } from "./commands.ts";
import { ThreadEvent } from "./events.ts";
import { FlowTemplate } from "./flows.ts";
import { InboxEntry } from "./inbox.ts";
import { Item } from "./items.ts";
import { UserRequest } from "./requests.ts";
import {
  GlobalStreamMessage,
  StreamMessage,
  ThreadSnapshot,
} from "./stream.ts";
import { Thread } from "./thread.ts";
import { UsageSnapshot } from "./usage.ts";

/** Schemas published as JSON Schema (MCP tool inputs, docs, other languages). */
export const PUBLIC_SCHEMAS = {
  Thread,
  Item,
  ThreadEvent,
  ThreadCommand,
  UserRequest,
  FlowTemplate,
  InboxEntry,
  UsageSnapshot,
  ThreadSnapshot,
  StreamMessage,
  GlobalStreamMessage,
} as const;

export function jsonSchemas(): Record<keyof typeof PUBLIC_SCHEMAS, unknown> {
  return Object.fromEntries(
    Object.entries(PUBLIC_SCHEMAS).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    ]),
  ) as Record<keyof typeof PUBLIC_SCHEMAS, unknown>;
}
