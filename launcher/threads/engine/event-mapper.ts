// Translates provider callbacks (message, delta, tool) and rich events
// (ProviderEvent) into thread items. Persisted changes go through `persist`;
// streaming text and command output go through `delta` and are not stored.
import type {
  AgentRef,
  DeltaField,
  FileDiff,
  Item,
  NewThreadEvent,
  RateLimitWindow,
  ThreadEvent,
  TokenUsage,
} from "../../../contracts/src/index.ts";
import type { ProviderEvent } from "../../lib/providers/controller-types.d.mts";

export interface LegacyToolValue {
  nombre?: string;
  resumen?: string;
  resultado?: string;
  estado: "pendiente" | "ok" | "error";
}

export interface MapperSink {
  persist(event: NewThreadEvent): ThreadEvent;
  delta(itemId: string, field: DeltaField, delta: string): void;
}

export interface EventMapper {
  message(id: string, text: string): void;
  delta(id: string, text: string): void;
  tool(id: string, value: LegacyToolValue): void;
  emit(event: ProviderEvent): void;
  requestItem(requestId: string): void;
  notice(level: "info" | "warning" | "error", code: string, text: string): void;
  /** Completes open items and writes the usage item. */
  finish(outcome: "completed" | "interrupted" | "failed"): void;
  /** In-progress items with their streamed text, for stream joins. */
  liveItems(): Item[];
  /** Latest whole-turn diff reported by the provider, if any. */
  turnDiff(): FileDiff[] | null;
}

type Draft = Omit<
  Item,
  "id" | "threadId" | "turnId" | "seq" | "agent" | "createdAt" | "updatedAt"
>;

export function createEventMapper({
  threadId,
  turnId,
  agent,
  sink,
  now = () => new Date().toISOString(),
  newItemId,
  onRateLimits,
}: {
  threadId: string;
  turnId: string;
  agent: AgentRef;
  sink: MapperSink;
  now?: () => string;
  newItemId: () => string;
  onRateLimits?: (windows: RateLimitWindow[]) => void;
}): EventMapper {
  const items = new Map<string, Item>();
  let openText: string | null = null;
  let openReasoning: string | null = null;
  let tokens: TokenUsage | null = null;
  const rateLimits = new Map<string, RateLimitWindow>();
  let lastTurnDiff: FileDiff[] | null = null;

  const write = (key: string, item: Item, type: NewThreadEvent["type"]) => {
    const stored = sink.persist({
      type,
      threadId,
      at: item.updatedAt,
      item,
    } as NewThreadEvent);
    if (item.seq === 0) item.seq = stored.seq;
    items.set(key, item);
    return item;
  };

  /** Creates or updates the item behind `key`. */
  const upsert = (
    key: string,
    build: (prev: Item | undefined) => Draft,
    final: boolean,
  ): Item => {
    const prev = items.get(key);
    const at = now();
    const next = {
      ...(prev ?? {
        id: newItemId(),
        threadId,
        turnId,
        seq: 0,
        agent,
        createdAt: at,
      }),
      ...build(prev),
      updatedAt: at,
    } as Item;
    return write(
      key,
      next,
      final ? "item.completed" : prev ? "item.updated" : "item.started",
    );
  };

  const isOpen = (key: string | null) =>
    key !== null && items.get(key)?.status === "in-progress";

  /** Streams into a provisional item, created on the first delta. */
  const streamInto = (
    key: string,
    kind: "assistant_message" | "reasoning",
    chunk: string,
  ) => {
    let item = items.get(key);
    if (!item || item.status !== "in-progress")
      item = upsert(
        key,
        () => ({ kind, status: "in-progress", text: "" }),
        false,
      );
    (item as { text: string }).text += chunk;
    sink.delta(item.id, "text", chunk);
    return key;
  };

  /** Completes a provisional item (or creates a finished one) with final text. */
  const settleText = (
    key: string,
    openKey: string | null,
    kind: "assistant_message" | "reasoning",
    text: string,
  ) => {
    const target = isOpen(key)
      ? key
      : isOpen(openKey)
        ? (openKey as string)
        : key;
    upsert(target, () => ({ kind, status: "completed", text }), true);
    // A later delta with the same provider id starts a new item.
    items.delete(target);
    if (target !== key) items.delete(key);
  };

  const mapper: EventMapper = {
    message(id, text) {
      settleText(`text:${id}`, openText, "assistant_message", text);
      openText = null;
    },

    delta(id, text) {
      openText = streamInto(`text:${id}`, "assistant_message", text);
    },

    tool(id, value) {
      if (
        items.has(`cmd:${id}`) ||
        items.has(`fc:${id}`) ||
        items.has(`sub:${id}`)
      )
        return;
      const key = `tool:${id}`;
      const final = value.estado !== "pendiente";
      upsert(
        key,
        (prev) => {
          const before = prev?.kind === "tool_call" ? prev : undefined;
          return {
            kind: "tool_call",
            status:
              value.estado === "pendiente"
                ? "in-progress"
                : value.estado === "error"
                  ? "failed"
                  : "completed",
            name: value.nombre || before?.name || "tool",
            input: before?.input ?? value.resumen ?? null,
            ...(value.estado === "error"
              ? { error: value.resultado ?? "" }
              : value.resultado !== undefined
                ? { output: value.resultado }
                : before?.output !== undefined
                  ? { output: before.output }
                  : {}),
          };
        },
        final,
      );
    },

    emit(event) {
      switch (event.type) {
        case "reasoning":
          if (event.delta)
            openReasoning = streamInto(
              `reasoning:${event.id}`,
              "reasoning",
              event.text,
            );
          else {
            settleText(
              `reasoning:${event.id}`,
              openReasoning,
              "reasoning",
              event.text,
            );
            openReasoning = null;
          }
          return;
        case "plan":
          upsert(
            `plan:${event.id}`,
            () => ({
              kind: "plan",
              status: "in-progress",
              ...(event.explanation ? { explanation: event.explanation } : {}),
              steps: event.steps,
            }),
            false,
          );
          return;
        case "todo_list":
          upsert(
            `todo:${event.id}`,
            () => ({
              kind: "todo_list",
              status: "in-progress",
              todos: event.todos,
            }),
            false,
          );
          return;
        case "file_change":
          upsert(
            `fc:${event.id}`,
            () => ({
              kind: "file_change",
              status: event.status,
              diffs: event.diffs,
            }),
            event.status !== "in-progress",
          );
          return;
        case "turn_diff":
          lastTurnDiff = event.diffs;
          return;
        case "command": {
          const key = `cmd:${event.id}`;
          const prev = items.get(key);
          if (
            event.outputDelta !== undefined &&
            prev?.kind === "command" &&
            event.status === "in-progress"
          ) {
            prev.output += event.outputDelta;
            sink.delta(prev.id, "output", event.outputDelta);
            return;
          }
          const before = prev?.kind === "command" ? prev : undefined;
          const item = upsert(
            key,
            () => ({
              kind: "command",
              status: event.status,
              command: event.command || before?.command || "",
              ...((event.cwd ?? before?.cwd)
                ? { cwd: event.cwd ?? before?.cwd }
                : {}),
              output: event.output ?? before?.output ?? "",
              exitCode:
                event.exitCode !== undefined
                  ? event.exitCode
                  : (before?.exitCode ?? null),
              ...(event.durationMs !== undefined
                ? { durationMs: event.durationMs }
                : {}),
            }),
            event.status !== "in-progress",
          );
          if (event.outputDelta && item.kind === "command") {
            item.output += event.outputDelta;
            sink.delta(item.id, "output", event.outputDelta);
          }
          return;
        }
        case "subagent": {
          if (
            event.activity !== undefined &&
            event.status === "in-progress" &&
            items.has(`sub:${event.id}`)
          )
            return;
          upsert(
            `sub:${event.id}`,
            (prev) => {
              const before = prev?.kind === "subagent" ? prev : undefined;
              return {
                kind: "subagent",
                status: event.status,
                name: event.name || before?.name || "agent",
                ...((event.description ?? before?.description) !== undefined
                  ? { description: event.description ?? before?.description }
                  : {}),
                ...((event.prompt ?? before?.prompt) !== undefined
                  ? { prompt: event.prompt ?? before?.prompt }
                  : {}),
                ...((event.result ?? before?.result) !== undefined
                  ? { result: event.result ?? before?.result }
                  : {}),
              };
            },
            event.status !== "in-progress",
          );
          return;
        }
        case "usage":
          tokens = event.tokens;
          return;
        case "rate_limits": {
          const windows: RateLimitWindow[] = [];
          for (const w of event.windows) {
            if (w.usedPercent === null) continue;
            const window: RateLimitWindow = {
              window: w.window,
              usedPercent: w.usedPercent,
              resetsAt: w.resetsAt,
              ...(w.status ? { status: w.status } : {}),
            };
            rateLimits.set(w.window, window);
            windows.push(window);
          }
          if (windows.length) onRateLimits?.(windows);
          return;
        }
        case "mode":
          mapper.notice("info", "mode", event.mode);
          return;
      }
    },

    requestItem(requestId) {
      upsert(
        `req:${requestId}`,
        () => ({ kind: "user_request", status: "completed", requestId }),
        true,
      );
    },

    notice(level, code, text) {
      upsert(
        `notice:${newItemId()}`,
        () => ({ kind: "notice", status: "completed", level, code, text }),
        true,
      );
    },

    finish(outcome) {
      for (const [key, item] of items) {
        if (item.status !== "in-progress") continue;
        const failed =
          outcome !== "completed" &&
          (item.kind === "command" ||
            item.kind === "tool_call" ||
            item.kind === "subagent");
        upsert(
          key,
          (prev) => ({
            ...(prev as Draft),
            status: failed ? "failed" : "completed",
          }),
          true,
        );
      }
      if (tokens || rateLimits.size)
        upsert(
          `usage:${turnId}`,
          () => ({
            kind: "usage",
            status: "completed",
            tokens: tokens ?? { inputTokens: 0, outputTokens: 0 },
            rateLimits: [...rateLimits.values()],
          }),
          true,
        );
      openText = null;
      openReasoning = null;
    },

    liveItems() {
      return [...items.values()]
        .filter((item) => item.status === "in-progress")
        .map((item) => structuredClone(item));
    },

    turnDiff() {
      return lastTurnDiff;
    },
  };
  return mapper;
}
