// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEvent,
  applyMessage,
  formatDuration,
  fromSnapshot,
  groupTurns,
  openRequests,
  type ThreadView,
} from "../src/features/threads/thread-store";
import type {
  Item,
  Thread,
  ThreadSnapshot,
  UserRequest,
} from "../src/features/threads/thread-types";
// Static, so loading the timeline does not count against the test timeout.
import { Timeline } from "../src/features/threads/Timeline";
import { MessageItem, toolLabel } from "../src/features/threads/items";
import { plainTitle } from "../src/features/threads/dialogs";

const fixture = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("../src/features/threads/thread-api", () => ({
  threadsApi: { answer: fixture.answer },
}));
afterEach(() => {
  cleanup();
  fixture.answer.mockReset();
});

const AT = "2026-11-20T10:00:00.000Z";
const thread: Thread = {
  id: "thr_test000001",
  title: "Prueba",
  kind: "scratch",
  status: "running",
  autonomy: "auto-worktree",
  agent: { engine: "codex" },
  repo: null,
  workspace: "/tmp/x",
  parentId: null,
  flow: null,
  stageIndex: 0,
  counters: { turns: 1, reviewRounds: 0, subtasks: 0 },
  limits: { maxTurns: 40, maxReviewRounds: 3 },
  lastSeq: 3,
  closeMode: null,
  prUrl: null,
  createdAt: AT,
  updatedAt: AT,
} as Thread;

const base = (id: string, turnId: string | null, at = AT) => ({
  id,
  threadId: thread.id,
  turnId,
  seq: 1,
  status: "completed" as const,
  agent: { engine: "codex" as const },
  createdAt: at,
  updatedAt: at,
});

const items: Item[] = [
  {
    ...base("itm_user00001", null),
    kind: "user_message",
    text: "Hola",
    delivery: "send",
    attachments: [],
  },
  {
    ...base("itm_cmd000001", "trn_turn00001"),
    kind: "command",
    command: "npm test",
    output: "ok",
    exitCode: 0,
    updatedAt: "2026-11-20T10:00:42.000Z",
  },
  {
    ...base("itm_msg000001", "trn_turn00001"),
    status: "in-progress",
    kind: "assistant_message",
    text: "Hola",
  },
] as Item[];

const snapshot: ThreadSnapshot = {
  thread,
  items,
  requests: [],
  lastSeq: 3,
} as ThreadSnapshot;

const event = (seq: number, data: Record<string, unknown>) =>
  ({ threadId: thread.id, seq, globalSeq: seq, at: AT, ...data }) as never;

describe("thread store", () => {
  it("applies events in order and ignores replays", () => {
    let view = fromSnapshot(snapshot);
    expect(view.activeTurn).toBe("trn_turn00001");
    view = applyEvent(
      view,
      event(4, { type: "thread.updated", patch: { status: "idle" } }),
    );
    expect(view.thread.status).toBe("idle");
    expect(
      applyEvent(
        view,
        event(4, { type: "thread.updated", patch: { status: "failed" } }),
      ),
    ).toBe(view);
    view = applyEvent(
      view,
      event(5, {
        type: "turn.completed",
        turnId: "trn_turn00001",
        outcome: "completed",
      }),
    );
    expect(view.activeTurn).toBeNull();
    const request: UserRequest = {
      id: "req_ask000001",
      threadId: thread.id,
      turnId: null,
      kind: "question",
      title: "¿A o B?",
      body: "",
      options: [
        { id: "o1", label: "A" },
        { id: "o2", label: "B" },
      ],
      status: "open",
      answer: null,
      origin: null,
      createdAt: AT,
      answeredAt: null,
    };
    view = applyEvent(view, event(6, { type: "request.opened", request }));
    expect(openRequests(view)).toHaveLength(1);
    view = applyEvent(
      view,
      event(7, {
        type: "request.resolved",
        requestId: request.id,
        status: "answered",
        answer: { optionId: "o2" },
        origin: "discord",
      }),
    );
    expect(openRequests(view)).toHaveLength(0);
    expect(view.requests[0]!.origin).toBe("discord");
    expect(view.lastSeq).toBe(7);
  });

  it("streams deltas into items and asks for a snapshot when told", () => {
    let view: ThreadView | null = fromSnapshot(snapshot);
    view = applyMessage(view, {
      type: "item.delta",
      threadId: thread.id,
      itemId: "itm_msg000001",
      field: "text",
      delta: " mundo",
      afterSeq: 3,
    })!;
    expect((view.items[2] as { text: string }).text).toBe("Hola mundo");
    view = applyMessage(view, {
      type: "item.delta",
      threadId: thread.id,
      itemId: "itm_cmd000001",
      field: "output",
      delta: "!",
      afterSeq: 3,
    })!;
    expect((view.items[1] as { output: string }).output).toBe("ok!");
    view = applyMessage(view, {
      type: "item.delta",
      threadId: thread.id,
      itemId: "itm_new000001",
      field: "text",
      delta: "Nuevo",
      afterSeq: 3,
    })!;
    expect(view.items.at(-1)).toMatchObject({
      kind: "assistant_message",
      text: "Nuevo",
      turnId: "trn_turn00001",
    });
    expect(applyMessage(view, { type: "heartbeat" })).toBe(view);
    expect(
      applyMessage(view, {
        type: "snapshot-required",
        threadId: thread.id,
        reason: "x",
      }),
    ).toBeNull();
  });

  it("groups a turn's work apart from its messages", () => {
    const groups = groupTurns(fromSnapshot(snapshot));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.prompt?.id).toBe("itm_user00001");
    expect(groups[1]!.work.map((i) => i.kind)).toEqual(["command"]);
    expect(groups[1]!.messages.map((i) => i.kind)).toEqual([
      "assistant_message",
    ]);
    expect(groups[1]!.running).toBe(true);
  });

  it("formats durations", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(3_720_000)).toBe("1 h 2 min");
  });
});

describe("thread timeline", () => {
  it("folds finished work and answers a question inline", async () => {
    const done = applyEvent(
      fromSnapshot({
        ...snapshot,
        items: items.map((i) => ({ ...i, status: "completed" })) as Item[],
      }),
      event(4, {
        type: "turn.completed",
        turnId: "trn_turn00001",
        outcome: "completed",
      }),
    );
    const view = applyEvent(
      done,
      event(5, {
        type: "request.opened",
        request: {
          id: "req_ask000001",
          threadId: thread.id,
          turnId: null,
          kind: "question",
          title: "¿Qué rama?",
          body: "",
          options: [
            { id: "o1", label: "main" },
            { id: "o2", label: "dev" },
          ],
          status: "open",
          answer: null,
          origin: null,
          createdAt: AT,
          answeredAt: null,
        },
      }),
    );
    fixture.answer.mockResolvedValue({});
    const onAnswered = vi.fn();
    render(<Timeline view={view} onAnswered={onAnswered} />);
    const toggle = screen.getByRole("button", {
      name: /Trabajó 42 s · 1 paso/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(screen.getByText("$ npm test")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "dev" }));
    expect(fixture.answer).toHaveBeenCalledWith(thread.id, "req_ask000001", {
      optionId: "o2",
    });
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });
});

describe("thread texts", () => {
  it("names tools and hand-offs for people", () => {
    expect(toolLabel("mcp__secondbrain__thread_report_review")).toBe(
      "Reporta la revisión",
    );
    expect(toolLabel("Bash")).toBe("Comando");
    expect(toolLabel("lookup", "github")).toBe("github: lookup");
    render(
      <MessageItem
        stages={["Planificar", "Implementar", "Revisar"]}
        item={
          {
            id: "itm_handoff001",
            threadId: "thr_abc1234567",
            turnId: null,
            seq: 9,
            status: "completed",
            agent: null,
            createdAt: AT,
            updatedAt: AT,
            kind: "handoff",
            fromStage: 0,
            toStage: 1,
            narrative: "Plan listo.",
            openItems: [],
            brief: {
              diffstat: [{ path: "a.js", additions: 2, deletions: 0 }],
              commands: [{ command: "npm test", exitCode: 0 }],
              failedTests: [],
              errors: [],
              files: ["a.js"],
            },
          } as unknown as Item
        }
      />,
    );
    expect(screen.getByText("Traspaso: Planificar → Implementar")).toBeTruthy();
    expect(screen.getByText("1 archivo · 1 comando")).toBeTruthy();
  });

  it("makes commit titles out of Markdown prompts", () => {
    expect(plainTitle("Crea `principal.txt` con la línea **padre**")).toBe(
      "Crea principal.txt con la línea padre",
    );
    expect(
      plainTitle(
        "Crea un archivo con una línea muy larga que no cabe en el título del commit de ninguna manera",
      ),
    ).toBe("Crea un archivo con una línea muy larga que no cabe en el…");
  });
});
