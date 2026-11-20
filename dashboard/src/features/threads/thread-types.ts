// Thread types come from the shared contracts (ADR 0011). Only types are
// imported, so the bundle never pulls the contracts or Zod in.
export type {
  AgentRef,
  FileDiff,
  InboxEntry,
  Item,
  ItemOf,
  RequestAnswer,
  StreamMessage,
  Thread,
  ThreadEvent,
  ThreadSnapshot,
  ThreadStatus,
  UserRequest,
} from "../../../../contracts/src/index.ts";

export type Engine = "claude" | "codex" | "agy" | "deepseek";
