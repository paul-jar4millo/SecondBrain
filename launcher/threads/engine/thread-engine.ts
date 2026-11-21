// The thread engine: commands in, events out. Owns the live state of each
// thread (running turn, queued messages, provider controller, open provider
// requests) and writes every change to the event store.
import { existsSync } from "node:fs";
import {
  AgentHandoff,
  AgentQuestion,
  AgentReview,
  AgentSubtask,
  AnswerRequest,
  CloseThread,
  CreateThread,
  SendMessage,
  TERMINAL_STATUSES,
  newId,
  type AgentRef,
  type Attachment,
  type DeliveryMode,
  type FileDiff,
  type RequestAnswer,
  type RequestOrigin,
  type Item,
  type NewThreadEvent,
  type StreamMessage,
  type Thread,
  type ThreadEvent,
  type ThreadPatch,
  type ThreadSnapshot,
  type UserRequest,
} from "../../../contracts/src/index.ts";
import type { Store } from "../store/event-log.ts";
import { diffTrees, snapshotTree, type GitRun } from "./checkpoints.ts";
import { createEventMapper, type EventMapper } from "./event-mapper.ts";
import {
  isPlainApproval,
  toProviderAnswer,
  toUserRequest,
  type ProviderAnswer,
  type ProviderAsk,
} from "./provider-requests.ts";
import type { Scheduler, Slot } from "./scheduler.ts";
import type { ThreadWorkspaces } from "./workspace.ts";
import { CloseError, commitTitle, type Closing } from "./closing.ts";
import { currentStage, flowTemplate, freezeFlow, isReadOnly } from "./flows.ts";
import {
  briefMessage,
  collectBrief,
  resolveHandoff,
  stagePreamble,
} from "./handoff.ts";
import { isReviewStage, reviewDecision } from "./review.ts";
import { createUsageTracker } from "./usage-tracker.ts";

export interface ProviderController {
  isAlive(): boolean;
  runTurn(ctx: Record<string, unknown>): Promise<{ status?: string }>;
  interrupt(): void;
  shutdown(reason?: string): Promise<unknown>;
}

export interface AgentContextFactory {
  buildAgentContext(input: {
    threadId: string;
    agent: AgentRef;
    cwd: string;
    readOnly: boolean;
  }): Promise<Record<string, unknown>>;
  runSetup(input: {
    threadId: string;
    cwd: string;
    argv: string[];
    onOutput: (chunk: string) => void;
  }): Promise<number | null>;
  stopScope?(threadId: string): Promise<void>;
  /** Stores the thread's sbcap_ credential for its MCP servers. */
  saveToken?(threadId: string, token: string): Promise<void>;
  dropToken?(threadId: string): Promise<void>;
}

/** What the agent reads when the owner answers after its turn ended. */
export function answerText(request: UserRequest, answer: RequestAnswer) {
  const parts: string[] = [];
  if (answer.optionId)
    parts.push(
      request.options?.find((o) => o.id === answer.optionId)?.label ??
        answer.optionId,
    );
  if (answer.text) parts.push(answer.text);
  for (const [key, value] of Object.entries(answer.values ?? {}))
    parts.push(
      `${request.fields?.find((f) => f.id === key)?.label ?? key}: ${String(value)}`,
    );
  if (answer.approved !== undefined)
    parts.push(answer.approved ? "Aprobado" : "Rechazado");
  return `Respuesta a «${request.title}» (${request.id}):\n${parts.join("\n")}`;
}

export interface EngineDeps {
  store: Store;
  workspaces: ThreadWorkspaces;
  scheduler: Scheduler;
  git: GitRun;
  context: AgentContextFactory;
  controllers: Readonly<Record<string, () => ProviderController>>;
  now?: () => string;
  idleControllerMs?: number;
  /** Silence after which a running turn gets a "no signs" notice. */
  stallNoticeMs?: number;
  defaultMaxTurns?: number;
  closing?: Closing;
}

export type EngineErrorCode =
  "not-found" | "invalid-state" | "conflict" | "invalid";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

interface Control {
  supportsSteer: boolean;
  steer?: (text: string, attachments?: Attachment[]) => Promise<unknown>;
}

interface PendingRequest {
  ask: ProviderAsk;
  nativeId: string;
  turnId: string;
  resolve: (answer: ProviderAnswer) => void;
  reject: (error: Error) => void;
}

interface RunningTurn {
  id: string | null;
  mapper: EventMapper | null;
  abort: AbortController;
  control: Control;
  aborters: (() => void)[];
}

interface QueuedMessage {
  text: string;
  attachments: Attachment[];
  agent?: AgentRef;
  /** First message of a stage: the agent reads where it stands. */
  stageStart?: boolean;
}

interface PendingHandoff {
  turnId: string;
  index: number;
  narrative: string;
  openItems: string[];
}

interface Live {
  turn: RunningTurn | null;
  queue: QueuedMessage[];
  /** Queued messages a stop left undelivered; they go with the next one. */
  held: QueuedMessage[];
  controller: { instance: ProviderController; signature: string } | null;
  idleTimer: NodeJS.Timeout | null;
  pending: Map<string, PendingRequest>;
  lastSeq: number;
  loop: Promise<void> | null;
  handoff: PendingHandoff | null;
  review: (AgentReview & { turnId: string; round: number }) | null;
}

export type DeltaListener = (message: StreamMessage) => void;

const BUSY_STATUSES = new Set(["closing", ...TERMINAL_STATUSES]);

/**
 * A short title from the owner's prompt: its first sentence without
 * Markdown marks, cut at a word within 60 characters.
 */
export function titleOf(prompt: string) {
  const line = prompt.split("\n").find((l) => l.trim()) ?? "";
  const plain = line
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = (plain.split(/(?<=[.!?])\s/)[0] ?? plain).replace(/\.$/, "");
  if (!sentence) return "Thread";
  if (sentence.length <= 60) return sentence;
  const cut = sentence.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

export function createThreadEngine(deps: EngineDeps) {
  const {
    store,
    workspaces,
    scheduler,
    git,
    context,
    controllers,
    closing,
    now = () => new Date().toISOString(),
    idleControllerMs = 10 * 60_000,
    stallNoticeMs = 5 * 60_000,
    defaultMaxTurns = 40,
  } = deps;
  const lives = new Map<string, Live>();
  let closed = false;
  const deltaListeners = new Set<DeltaListener>();

  const live = (threadId: string): Live => {
    let state = lives.get(threadId);
    if (!state) {
      state = {
        turn: null,
        queue: [],
        held: [],
        controller: null,
        idleTimer: null,
        pending: new Map(),
        lastSeq: store.lastSeq(threadId),
        loop: null,
        handoff: null,
        review: null,
      };
      lives.set(threadId, state);
    }
    return state;
  };

  const append = (threadId: string, events: NewThreadEvent[]) => {
    if (closed)
      throw new EngineError("invalid-state", "El motor está detenido.");
    const stored = store.append(threadId, events);
    const last = stored.at(-1);
    if (last) live(threadId).lastSeq = last.seq;
    return stored;
  };

  const requireThread = (threadId: string): Thread => {
    const thread = store.getThread(threadId);
    if (!thread) throw new EngineError("not-found", "Thread no encontrado.");
    return thread;
  };

  const update = (threadId: string, patch: ThreadPatch) =>
    append(threadId, [{ type: "thread.updated", threadId, at: now(), patch }]);

  const setStatus = (threadId: string, status: Thread["status"]) => {
    if (requireThread(threadId).status !== status) update(threadId, { status });
  };

  /** A finished item outside any turn (user messages, notices). */
  const appendItem = (
    threadId: string,
    turnId: string | null,
    draft: Record<string, unknown>,
  ): Item => {
    const at = now();
    const item = {
      id: newId("item"),
      threadId,
      turnId,
      seq: 0,
      status: "completed",
      agent: null,
      createdAt: at,
      updatedAt: at,
      ...draft,
    } as Item;
    const [stored] = append(threadId, [
      { type: "item.completed", threadId, at, item },
    ]);
    return { ...item, seq: (stored as ThreadEvent).seq };
  };

  const notice = (
    threadId: string,
    level: "info" | "warning" | "error",
    code: string,
    text: string,
  ) => {
    const turn = lives.get(threadId)?.turn;
    if (turn?.mapper) turn.mapper.notice(level, code, text);
    else appendItem(threadId, null, { kind: "notice", level, code, text });
  };

  const publishDelta = (message: StreamMessage) => {
    for (const listener of deltaListeners) {
      try {
        listener(message);
      } catch {
        // A broken stream must not stop the turn.
      }
    }
  };

  const cwdOf = (thread: Thread) =>
    thread.repo?.worktree ?? thread.workspace ?? "";

  const signatureOf = (thread: Thread, agent: AgentRef) =>
    JSON.stringify({
      engine: agent.engine,
      model: agent.model ?? null,
      effort: agent.effort ?? null,
      cwd: cwdOf(thread),
      readOnly: isReadOnly(thread),
      stage: currentStage(thread)?.key ?? null,
    });

  /** Each stage keeps its own provider conversation. */
  /** The owner's first message: the task every stage works toward. */
  const originalTask = (threadId: string) => {
    const first = store
      .snapshot(threadId)
      ?.items.find((item) => item.kind === "user_message");
    return first?.kind === "user_message" ? first.text : "";
  };

  const conversationKey = (thread: Thread, agent: AgentRef) => {
    const stage = currentStage(thread);
    return stage && (thread.flow?.stages.length ?? 0) > 1
      ? `${stage.key}:${agent.engine}`
      : agent.engine;
  };

  const scheduleIdleShutdown = (threadId: string) => {
    const state = live(threadId);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.turn || !state.controller) return;
      const { instance } = state.controller;
      state.controller = null;
      void instance.shutdown("Controlador inactivo").catch(() => undefined);
    }, idleControllerMs);
    state.idleTimer.unref?.();
  };

  const controllerFor = async (
    threadId: string,
    thread: Thread,
    agent: AgentRef,
  ): Promise<ProviderController> => {
    const state = live(threadId);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const signature = signatureOf(thread, agent);
    if (
      state.controller?.signature === signature &&
      state.controller.instance.isAlive()
    )
      return state.controller.instance;
    if (state.controller) {
      const old = state.controller.instance;
      state.controller = null;
      await old
        .shutdown("Cambio de agente o configuración")
        .catch(() => undefined);
    }
    const factory = controllers[agent.engine];
    if (!factory)
      throw new EngineError("invalid", `Motor no disponible: ${agent.engine}`);
    const instance = factory();
    state.controller = { instance, signature };
    return instance;
  };

  const stopController = async (threadId: string) => {
    const state = live(threadId);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const controller = state.controller?.instance;
    state.controller = null;
    await controller?.shutdown("Thread cerrado").catch(() => undefined);
  };

  const cancelPending = (
    threadId: string,
    status: "cancelled" | "expired",
    reason: string,
    turnId?: string,
  ) => {
    const state = live(threadId);
    for (const [requestId, pending] of state.pending) {
      if (turnId && pending.turnId !== turnId) continue;
      state.pending.delete(requestId);
      if (store.getRequest(requestId)?.status === "open")
        append(threadId, [
          {
            type: "request.resolved",
            threadId,
            at: now(),
            requestId,
            status,
            answer: null,
            origin: null,
          },
        ]);
      pending.reject(new Error(reason));
    }
  };

  const handleAsk = (
    threadId: string,
    turn: RunningTurn,
    nativeId: string,
    ask: ProviderAsk,
  ): Promise<ProviderAnswer> => {
    const thread = requireThread(threadId);
    const turnId = turn.id as string;
    if (isPlainApproval(ask) && thread.autonomy !== "ask") {
      const accept = thread.autonomy === "auto-worktree";
      // The tool call already shows in the timeline; only a refusal is news.
      if (!accept)
        turn.mapper?.notice(
          "info",
          "auto-declined",
          `Rechazado por la autonomía del thread: ${ask.title ?? "acción"}`,
        );
      return Promise.resolve({ decision: accept ? "accept" : "decline" });
    }
    const request = toUserRequest(ask, {
      id: newId("request"),
      threadId,
      turnId,
      createdAt: now(),
    });
    append(threadId, [
      { type: "request.opened", threadId, at: now(), request },
    ]);
    turn.mapper?.requestItem(request.id);
    setStatus(threadId, "waiting-user");
    return new Promise<ProviderAnswer>((resolve, reject) => {
      live(threadId).pending.set(request.id, {
        ask,
        nativeId,
        turnId,
        resolve,
        reject,
      });
    });
  };

  const hasOpenRequests = (threadId: string) =>
    store.requests(threadId).some((r) => r.status === "open");

  const agentRequestIds = (threadId: string) =>
    new Set(store.meta(threadId).agentRequests ?? []);

  const finishStatus = (threadId: string) => {
    const thread = requireThread(threadId);
    if (BUSY_STATUSES.has(thread.status)) return;
    setStatus(
      threadId,
      thread.counters.turns >= thread.limits.maxTurns
        ? "needs-decision"
        : hasOpenRequests(threadId)
          ? "waiting-user"
          : "idle",
    );
  };

  async function runTurn(threadId: string, message: QueuedMessage) {
    const state = live(threadId);
    const turn: RunningTurn = {
      id: null,
      mapper: null,
      abort: new AbortController(),
      control: { supportsSteer: false },
      aborters: [],
    };
    state.turn = turn;
    let slot: Slot | null = null;
    try {
      slot = await scheduler.acquire(threadId, "user", {
        signal: turn.abort.signal,
        onWaiting: () =>
          notice(threadId, "info", "capacity", "Esperando capacidad…"),
      });
    } catch {
      state.turn = null;
      return;
    }
    const turnId = newId("turn");
    turn.id = turnId;
    let thread = requireThread(threadId);
    const agent = message.agent ?? thread.agent;
    const patch: ThreadPatch = { status: "running" };
    if (JSON.stringify(agent) !== JSON.stringify(thread.agent))
      patch.agent = agent;
    append(threadId, [
      { type: "thread.updated", threadId, at: now(), patch },
      {
        type: "turn.started",
        threadId,
        at: now(),
        turnId,
        agent,
        stageIndex: thread.stageIndex,
      },
    ]);
    thread = requireThread(threadId);
    const cwd = cwdOf(thread);
    let lastActivity = Date.now();
    const mapper = createEventMapper({
      threadId,
      turnId,
      agent,
      now,
      newItemId: () => newId("item"),
      sink: {
        persist: (event) => {
          lastActivity = Date.now();
          return append(threadId, [event])[0] as ThreadEvent;
        },
        delta: (itemId, field, delta) => {
          lastActivity = Date.now();
          publishDelta({
            type: "item.delta",
            threadId,
            itemId,
            field,
            delta,
            afterSeq: state.lastSeq,
          });
        },
      },
      onRateLimits: (windows) => usage.record(agent.engine, windows),
    });
    turn.mapper = mapper;
    // A provider that goes silent leaves the thread "working" forever; say
    // so, once, while nobody is being asked anything.
    let stallNoticed = false;
    const watchdog = setInterval(
      () => {
        if (
          stallNoticed ||
          state.pending.size > 0 ||
          Date.now() - lastActivity < stallNoticeMs
        )
          return;
        stallNoticed = true;
        mapper.notice(
          "warning",
          "turn-stalled",
          `El agente lleva ${Math.round(stallNoticeMs / 60_000)} min sin dar señales. Puede seguir pensando; si no avanza, pulsa Detener.`,
        );
      },
      Math.min(60_000, stallNoticeMs),
    );
    watchdog.unref?.();
    let outcome: "completed" | "interrupted" | "failed" = "completed";
    let error: string | undefined;
    const beforeTree = thread.repo
      ? await snapshotTree(git, cwd).catch(() => null)
      : null;
    store.recordCheckpoint({ turnId, threadId, beforeTree, afterTree: null });
    try {
      const base = await context.buildAgentContext({
        threadId,
        agent,
        cwd,
        readOnly: isReadOnly(thread),
      });
      const controller = await controllerFor(threadId, thread, agent);
      if (turn.abort.signal.aborted) throw new Error("Interrumpido");
      const nativeIds = store.meta(threadId).nativeIds ?? {};
      const conversation = conversationKey(thread, agent);
      const preamble = message.stageStart
        ? stagePreamble(thread, originalTask(threadId))
        : "";
      let sequence = 0;
      const ctx: Record<string, unknown> = {
        ...base,
        session: {
          ...(base.session as Record<string, unknown>),
          conversacionId: nativeIds[conversation] ?? null,
        },
        turnId,
        prompt: preamble ? `${preamble}\n\n${message.text}` : message.text,
        attachments: message.attachments,
        nextId: () => ++sequence,
        onAbort: (fn: () => void) => turn.aborters.push(fn),
        onControl: (next: Partial<Control>) => {
          turn.control = { ...turn.control, ...next };
        },
        invalidateConnection: () => undefined,
        nativeId: (id: string) => {
          if (nativeIds[conversation] === id) return;
          nativeIds[conversation] = id;
          store.setMeta(threadId, { nativeIds: { ...nativeIds } });
        },
        message: (id: string, text: string) => mapper.message(id, text),
        delta: (id: string, text: string) => mapper.delta(id, text),
        tool: (id: string, value: Parameters<EventMapper["tool"]>[1]) =>
          mapper.tool(id, value),
        emit: (event: Parameters<EventMapper["emit"]>[0]) => mapper.emit(event),
        artifact: async () => null,
        expire: (nativeRequestId: string) => {
          for (const [requestId, pending] of state.pending)
            if (pending.nativeId === nativeRequestId) {
              state.pending.delete(requestId);
              append(threadId, [
                {
                  type: "request.resolved",
                  threadId,
                  at: now(),
                  requestId,
                  status: "expired",
                  answer: null,
                  origin: null,
                },
              ]);
              pending.reject(new Error("La solicitud del proveedor venció"));
            }
        },
        ask: (nativeRequestId: string, request: ProviderAsk) =>
          handleAsk(threadId, turn, String(nativeRequestId), request),
      };
      const result = await controller.runTurn(ctx);
      outcome =
        result?.status === "interrupted" || turn.abort.signal.aborted
          ? "interrupted"
          : "completed";
    } catch (cause) {
      outcome = turn.abort.signal.aborted ? "interrupted" : "failed";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    clearInterval(watchdog);
    cancelPending(threadId, "cancelled", "El turno terminó", turnId);
    if (outcome === "failed")
      mapper.notice("error", "turn-failed", error ?? "El turno falló.");
    mapper.finish(outcome);
    turn.mapper = null;
    const afterTree = thread.repo
      ? await snapshotTree(git, cwd).catch(() => null)
      : null;
    store.recordCheckpoint({ turnId, threadId, beforeTree: null, afterTree });
    append(threadId, [
      {
        type: "turn.completed",
        threadId,
        at: now(),
        turnId,
        outcome,
        ...(error ? { error } : {}),
      },
    ]);
    state.turn = null;
    slot.release();
    let handoff = state.handoff;
    state.handoff = null;
    const review = state.review?.turnId === turnId ? state.review : null;
    state.review = null;
    let reviewStatus: Thread["status"] | undefined;
    if (review && outcome === "completed") {
      // The verdict decides where the thread goes, over any hand-off.
      const decision = reviewDecision(requireThread(threadId), review);
      handoff = decision.handoff ? { turnId, ...decision.handoff } : null;
      reviewStatus = decision.status;
      if (decision.notice)
        notice(threadId, "warning", "review-limit", decision.notice);
    }
    if (handoff?.turnId === turnId) {
      if (outcome === "completed")
        await applyHandoff(threadId, handoff).catch((cause: Error) =>
          notice(threadId, "error", "handoff-failed", cause.message),
        );
      else
        notice(
          threadId,
          "warning",
          "handoff-dropped",
          "El turno no terminó bien; el traspaso no se hizo.",
        );
    }
    finishStatus(threadId);
    if (reviewStatus && requireThread(threadId).status === "idle")
      setStatus(threadId, reviewStatus);
    scheduleIdleShutdown(threadId);
  }

  /** Moves the thread to the next stage once the handing turn ended. */
  async function applyHandoff(threadId: string, handoff: PendingHandoff) {
    const thread = requireThread(threadId);
    const target = thread.flow?.stages[handoff.index];
    if (!target || BUSY_STATUSES.has(thread.status)) return;
    const items = store.snapshot(threadId)?.items ?? [];
    const lastHandoff = items.findLast((item) => item.kind === "handoff");
    const stageTurns = new Set(
      store
        .turns(threadId)
        .filter(
          (turn) =>
            turn.stageIndex === thread.stageIndex &&
            turn.startedSeq > (lastHandoff?.seq ?? 0),
        )
        .map((turn) => turn.id),
    );
    const brief = collectBrief(
      items.filter((item) => item.turnId && stageTurns.has(item.turnId)),
      await engine.diff(threadId).catch(() => []),
    );
    appendItem(threadId, null, {
      kind: "handoff",
      handoffId: newId("handoff"),
      fromStage: thread.stageIndex,
      toStage: handoff.index,
      narrative: handoff.narrative,
      openItems: handoff.openItems,
      brief,
    });
    update(threadId, { stageIndex: handoff.index, agent: target.agent });
    live(threadId).queue.unshift({
      text: briefMessage({
        thread,
        from: thread.stageIndex,
        narrative: handoff.narrative,
        openItems: handoff.openItems,
        brief,
      }),
      attachments: [],
      stageStart: true,
    });
  }

  /** Runs queued messages one turn at a time. */
  const kick = (threadId: string) => {
    const state = live(threadId);
    if (state.loop) return state.loop;
    state.loop = (async () => {
      try {
        while (!state.turn && state.queue.length) {
          const thread = store.getThread(threadId);
          if (!thread || BUSY_STATUSES.has(thread.status)) {
            state.queue.length = 0;
            state.held.length = 0;
            break;
          }
          if (
            thread.status === "setting-up" ||
            thread.status === "needs-decision"
          )
            break;
          await runTurn(threadId, state.queue.shift() as QueuedMessage).catch(
            () => undefined,
          );
        }
      } finally {
        state.loop = null;
      }
    })();
    return state.loop;
  };

  async function setup(threadId: string) {
    const thread = requireThread(threadId);
    const cwd = cwdOf(thread);
    const argv = thread.repo ? await workspaces.setupCommand(cwd) : null;
    if (argv) {
      const command = argv.join(" ");
      const item = appendItem(threadId, null, {
        kind: "command",
        status: "in-progress",
        command,
        cwd,
        output: "",
        exitCode: null,
      });
      let output = "";
      const started = Date.now();
      const exitCode = await context.runSetup({
        threadId,
        cwd,
        argv,
        onOutput: (chunk) => {
          output += chunk;
          publishDelta({
            type: "item.delta",
            threadId,
            itemId: item.id,
            field: "output",
            delta: chunk,
            afterSeq: live(threadId).lastSeq,
          });
        },
      });
      append(threadId, [
        {
          type: "item.completed",
          threadId,
          at: now(),
          item: {
            ...item,
            status: exitCode === 0 ? "completed" : "failed",
            output: output.slice(-200_000),
            exitCode,
            durationMs: Date.now() - started,
            updatedAt: now(),
          } as Item,
        },
      ]);
      if (exitCode !== 0)
        notice(
          threadId,
          "warning",
          "setup-failed",
          "La instalación de dependencias falló; el agente puede reintentarla.",
        );
    }
    if (requireThread(threadId).status === "setting-up")
      setStatus(threadId, "idle");
  }

  const usage = createUsageTracker({ store, now });

  const answeringSubtasks = new Set<string>();

  /** Approves (creating the child thread) or rejects a subtask request. */
  async function settleSubtask(
    threadId: string,
    requestId: string,
    request: UserRequest & { subtask: NonNullable<UserRequest["subtask"]> },
    answer: { answer: RequestAnswer; origin: RequestOrigin },
    childId: unknown,
    capabilityToken: unknown,
  ): Promise<UserRequest> {
    const parsed = { data: answer };
    const parent = requireThread(threadId);
    const draft = request.subtask;
    let text: string;
    if (parsed.data.answer.approved) {
      if (BUSY_STATUSES.has(parent.status) || !parent.repo)
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      const child = await engine.create({
        kind: "repo",
        repoPath: parent.repo.path,
        baseBranch: parent.repo.branch,
        title: draft.title,
        prompt: draft.prompt,
        agent: draft.agent,
        autonomy: parent.autonomy === "read-only" ? "ask" : parent.autonomy,
        parentId: threadId,
        ...(childId !== undefined ? { threadId: childId } : {}),
        ...(capabilityToken !== undefined ? { capabilityToken } : {}),
      });
      const current = requireThread(threadId);
      update(threadId, {
        counters: {
          ...current.counters,
          subtasks: current.counters.subtasks + 1,
        },
      });
      text = `Sub-tarea «${draft.title}» aprobada: thread ${child.id}, rama ${child.repo?.branch}. Consulta su avance con thread_subtask_status e intégrala en tu rama con thread_integrate_subtask cuando termine.`;
    } else
      text = `Sub-tarea «${draft.title}» rechazada por el dueño.${parsed.data.answer.text ? ` ${parsed.data.answer.text}` : ""}`;
    append(threadId, [
      {
        type: "request.resolved",
        threadId,
        at: now(),
        requestId,
        status: "answered",
        answer: parsed.data.answer,
        origin: parsed.data.origin,
      },
    ]);
    // The agent learns the answer in its next turn, even if one is running.
    const state = live(threadId);
    appendItem(threadId, null, {
      kind: "user_message",
      text,
      delivery: state.turn ? "queue" : "send",
      attachments: [],
    });
    state.queue.push({ text, attachments: [] });
    void kick(threadId);
    return store.getRequest(requestId) as UserRequest;
  }

  const engine = {
    /** Latest plan limits seen in this engine's provider events. */
    usage: usage.latest,

    async create(input: unknown): Promise<Thread> {
      const { capabilityToken, threadId, ...fields } = (input ?? {}) as Record<
        string,
        unknown
      >;
      const parsed = CreateThread.safeParse({
        ...fields,
        type: "CreateThread",
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const command = parsed.data;
      let flow: Thread["flow"] = null;
      if (command.flowTemplateId !== undefined) {
        const template = flowTemplate(command.flowTemplateId);
        if (!template) throw new EngineError("invalid", "Flujo desconocido.");
        try {
          flow = freezeFlow(template, command.agent, command.stageAgents);
        } catch (cause) {
          throw new EngineError("invalid", (cause as Error).message);
        }
      } else if (command.stageAgents)
        throw new EngineError(
          "invalid",
          "Elegir agentes por etapa requiere un flujo.",
        );
      // The service may choose the id, so the thread's credential is bound
      // to it before the first turn starts.
      let id = newId("thread");
      if (threadId !== undefined) {
        if (
          typeof threadId !== "string" ||
          !/^thr_[0-9A-Za-z_-]{6,64}$/.test(threadId)
        )
          throw new EngineError("invalid", "Identificador de thread inválido.");
        if (store.getThread(threadId))
          throw new EngineError("conflict", "El thread ya existe.");
        id = threadId;
      }
      const title =
        command.title?.trim().slice(0, 80) || titleOf(command.prompt);
      let repo: Thread["repo"] = null;
      let workspace: string | null = null;
      if (command.kind === "repo") {
        const info = await workspaces
          .prepareRepo({
            threadId: id,
            title,
            repo: command.repoPath as string,
            ...(command.baseBranch ? { baseBranch: command.baseBranch } : {}),
          })
          .catch((cause: Error) => {
            throw new EngineError("invalid", cause.message);
          });
        repo = {
          path: info.path,
          baseBranch: info.baseBranch,
          branch: info.branch,
          worktree: info.worktree,
        };
        store.setMeta(id, { baseCommit: info.baseCommit });
      } else workspace = await workspaces.prepareScratch(id);
      if (
        typeof capabilityToken === "string" &&
        /^sbcap_[a-f0-9]{16,128}$/.test(capabilityToken)
      )
        await context.saveToken?.(id, capabilityToken);
      const at = now();
      const thread: Thread = {
        id,
        title,
        kind: command.kind,
        status: command.kind === "repo" ? "setting-up" : "idle",
        autonomy: command.autonomy,
        agent: flow?.stages[0]?.agent ?? command.agent,
        repo,
        workspace,
        parentId: command.parentId ?? null,
        flow,
        stageIndex: 0,
        counters: { turns: 0, reviewRounds: 0, subtasks: 0 },
        limits: {
          maxTurns: defaultMaxTurns,
          maxReviewRounds: flow?.maxReviewRounds ?? 3,
        },
        lastSeq: 0,
        closeMode: null,
        prUrl: null,
        createdAt: at,
        updatedAt: at,
      };
      append(id, [{ type: "thread.created", threadId: id, at, thread }]);
      appendItem(id, null, {
        kind: "user_message",
        text: command.prompt,
        delivery: "send",
        attachments: command.attachments,
      });
      live(id).queue.push({
        text: command.prompt,
        attachments: command.attachments,
        stageStart: true,
      });
      void (async () => {
        if (thread.status === "setting-up")
          await setup(id).catch((cause: Error) => {
            notice(id, "error", "setup-error", cause.message);
            setStatus(id, "idle");
          });
        await kick(id);
      })();
      return requireThread(id);
    },

    async send(threadId: string, input: unknown) {
      const parsed = SendMessage.safeParse({
        ...(input as object),
        type: "SendMessage",
        threadId,
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const { text, mode, attachments, agent } = parsed.data;
      const thread = requireThread(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      const state = live(threadId);
      const turn = state.turn;
      let delivery: DeliveryMode = turn ? "queue" : "send";
      if (turn && mode === "steer" && turn.id && turn.control.steer) {
        try {
          await turn.control.steer(text, attachments);
          delivery = "steer";
        } catch (cause) {
          notice(
            threadId,
            "warning",
            "steer-unavailable",
            `No se pudo redirigir el turno; el mensaje queda en cola. ${(cause as Error).message}`,
          );
        }
      } else if (turn && mode === "steer")
        notice(
          threadId,
          "info",
          "steer-unsupported",
          "Este agente no admite redirigir un turno; el mensaje queda en cola.",
        );
      const item = appendItem(
        threadId,
        delivery === "steer" ? (turn?.id ?? null) : null,
        {
          kind: "user_message",
          text,
          delivery,
          attachments,
        },
      );
      if (delivery !== "steer") {
        const held = state.held.splice(0);
        state.queue.push({
          text: [...held.map((m) => m.text), text].join("\n\n"),
          attachments: [...held.flatMap((m) => m.attachments), ...attachments],
          ...(agent ? { agent } : {}),
          ...(held.some((m) => m.stageStart) ? { stageStart: true } : {}),
        });
        if (thread.status === "needs-decision")
          // The owner chose to go on: more turns and one more review round.
          update(threadId, {
            status: "idle",
            limits: {
              ...thread.limits,
              maxTurns: thread.counters.turns + defaultMaxTurns,
              maxReviewRounds: Math.max(
                thread.limits.maxReviewRounds,
                thread.counters.reviewRounds + 1,
              ),
            },
          });
        void kick(threadId);
      }
      return { item, delivery };
    },

    interrupt(threadId: string) {
      requireThread(threadId);
      const state = live(threadId);
      const waiting = state.queue.splice(0);
      if (waiting.length) {
        state.held.push(...waiting);
        notice(
          threadId,
          "info",
          "queue-held",
          waiting.length === 1
            ? "El mensaje en cola se enviará junto con tu próximo mensaje."
            : `Los ${waiting.length} mensajes en cola se enviarán junto con tu próximo mensaje.`,
        );
      }
      const turn = state.turn;
      if (!turn) return false;
      turn.abort.abort();
      cancelPending(threadId, "cancelled", "Turno interrumpido");
      for (const fn of turn.aborters) {
        try {
          fn();
        } catch {
          // Best effort: the controller also watches the abort.
        }
      }
      return true;
    },

    answer(threadId: string, requestId: string, input: unknown): UserRequest {
      const parsed = AnswerRequest.safeParse({
        ...(input as object),
        type: "AnswerRequest",
        threadId,
        requestId,
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const request = store.getRequest(requestId);
      if (!request || request.threadId !== threadId)
        throw new EngineError("not-found", "Solicitud no encontrada.");
      if (request.status !== "open")
        throw new EngineError("conflict", "La solicitud ya fue respondida.");
      if (request.kind === "subtask")
        throw new EngineError(
          "invalid",
          "Las sub-tareas se aprueban con answerSubtask.",
        );
      const state = live(threadId);
      const pending = state.pending.get(requestId);
      if (!pending && agentRequestIds(threadId).has(requestId)) {
        append(threadId, [
          {
            type: "request.resolved",
            threadId,
            at: now(),
            requestId,
            status: "answered",
            answer: parsed.data.answer,
            origin: parsed.data.origin,
          },
        ]);
        // A running turn polls for the answer; otherwise it starts a turn.
        if (!state.turn) {
          const text = answerText(request, parsed.data.answer);
          appendItem(threadId, null, {
            kind: "user_message",
            text,
            delivery: "send",
            attachments: [],
          });
          state.queue.push({ text, attachments: [] });
          void kick(threadId);
        }
        return store.getRequest(requestId) as UserRequest;
      }
      if (!pending) {
        append(threadId, [
          {
            type: "request.resolved",
            threadId,
            at: now(),
            requestId,
            status: "expired",
            answer: null,
            origin: null,
          },
        ]);
        throw new EngineError("conflict", "La solicitud ya no está activa.");
      }
      let providerAnswer: ProviderAnswer;
      try {
        providerAnswer = toProviderAnswer(
          pending.ask,
          request,
          parsed.data.answer,
        );
      } catch (cause) {
        throw new EngineError("invalid", (cause as Error).message);
      }
      state.pending.delete(requestId);
      append(threadId, [
        {
          type: "request.resolved",
          threadId,
          at: now(),
          requestId,
          status: "answered",
          answer: parsed.data.answer,
          origin: parsed.data.origin,
        },
      ]);
      pending.resolve(providerAnswer);
      if (state.turn && ![...state.pending.values()].length)
        setStatus(threadId, "running");
      return store.getRequest(requestId) as UserRequest;
    },

    /**
     * Closes a thread: `pr` pushes its branch and opens a pull request
     * (the worktree stays for follow-ups until archived), `merge` merges
     * it into the base branch locally, `discard` drops its work.
     */
    async close(threadId: string, input: unknown): Promise<Thread> {
      const parsed = CloseThread.safeParse({
        ...(input as object),
        type: "CloseThread",
        threadId,
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const { mode, title, body } = parsed.data;
      const thread = requireThread(threadId);
      const state = live(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      if (state.turn || thread.status === "setting-up")
        throw new EngineError(
          "invalid-state",
          "Detén el turno en curso antes de cerrar el thread.",
        );
      if (mode !== "discard" && !thread.repo)
        throw new EngineError(
          "invalid",
          "Solo un thread de repositorio puede cerrarse con PR o merge.",
        );
      if (mode !== "discard" && !closing)
        throw new EngineError(
          "invalid",
          "El cierre con git no está disponible.",
        );
      state.queue.length = 0;
      state.held.length = 0;
      const previous = thread.status;
      setStatus(threadId, "closing");
      const repo = thread.repo;
      const message = commitTitle(title, thread.title);
      try {
        let prUrl: string | null = null;
        if (mode === "pr" && repo && closing)
          prUrl = await closing.pullRequest(
            repo,
            message,
            body ?? `Trabajo del thread «${thread.title}».`,
          );
        else if (mode === "merge" && repo && closing)
          await closing.mergeLocal(repo, message);
        if (mode !== "pr") {
          // The agent runs inside the worktree: stop it before removing it.
          await stopController(threadId);
          if (repo)
            await workspaces.removeRepo({
              path: repo.path,
              worktree: repo.worktree,
              branch: repo.branch,
              keepBranch: false,
            });
          else if (thread.workspace)
            await workspaces.removeScratch(thread.workspace);
        } else await stopController(threadId);
        if (mode !== "pr") await context.dropToken?.(threadId);
        appendItem(threadId, null, {
          kind: "notice",
          level: "info",
          code: `closed-${mode}`,
          text:
            mode === "pr"
              ? `PR abierto: ${prUrl}`
              : mode === "merge"
                ? `Integrado en ${repo?.baseBranch}.`
                : "Trabajo descartado.",
        });
        update(threadId, { status: "done", closeMode: mode, prUrl });
      } catch (cause) {
        const conflicts = cause instanceof CloseError ? cause.conflicts : [];
        const text = (cause as Error).message;
        appendItem(threadId, null, {
          kind: "notice",
          level: "error",
          code: "close-failed",
          text: conflicts.length
            ? `${text} Archivos: ${conflicts.join(", ")}`
            : text,
        });
        setStatus(threadId, previous);
        throw new EngineError("conflict", text, { conflicts });
      }
      return requireThread(threadId);
    },

    /** Hides a thread and removes its worktree and branch (kept when it has a PR). */
    async archive(threadId: string): Promise<Thread> {
      const thread = requireThread(threadId);
      if (thread.status === "archived") return thread;
      if (live(threadId).turn || thread.status === "closing")
        throw new EngineError(
          "invalid-state",
          "Detén el turno en curso antes de archivar el thread.",
        );
      live(threadId).queue.length = 0;
      live(threadId).held.length = 0;
      await stopController(threadId);
      if (thread.repo)
        await workspaces
          .removeRepo({
            path: thread.repo.path,
            worktree: thread.repo.worktree,
            branch: thread.repo.branch,
            keepBranch: Boolean(thread.prUrl),
          })
          .catch(() => undefined);
      await context.dropToken?.(threadId);
      update(threadId, { status: "archived" });
      return requireThread(threadId);
    },

    /** A question from the agent (MCP); it survives the end of the turn. */
    askUser(threadId: string, input: unknown): UserRequest {
      const parsed = AgentQuestion.safeParse(input);
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const thread = requireThread(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      const { title, body, options, fields } = parsed.data;
      const state = live(threadId);
      const request: UserRequest = {
        id: newId("request"),
        threadId,
        turnId: state.turn?.id ?? null,
        kind: fields ? "form" : "question",
        title,
        body,
        ...(options
          ? { options: options.map((label, i) => ({ id: `o${i + 1}`, label })) }
          : {}),
        ...(fields ? { fields } : {}),
        status: "open",
        answer: null,
        origin: null,
        createdAt: now(),
        answeredAt: null,
      };
      store.setMeta(threadId, {
        agentRequests: [...agentRequestIds(threadId), request.id],
      });
      append(threadId, [
        { type: "request.opened", threadId, at: now(), request },
      ]);
      state.turn?.mapper?.requestItem(request.id);
      if (!state.turn) setStatus(threadId, "waiting-user");
      return store.getRequest(request.id) as UserRequest;
    },

    /** thread_request_subtask: a child thread waiting for the owner. */
    requestSubtask(threadId: string, input: unknown): UserRequest {
      const parsed = AgentSubtask.safeParse(input);
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const thread = requireThread(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      if (!thread.repo)
        throw new EngineError(
          "invalid",
          "Las sub-tareas necesitan un thread de repositorio.",
        );
      if (thread.parentId)
        throw new EngineError(
          "invalid",
          "Una sub-tarea no puede pedir sus propias sub-tareas.",
        );
      const { title, prompt, reason } = parsed.data;
      const agent = parsed.data.agent ?? thread.agent;
      const state = live(threadId);
      const request: UserRequest = {
        id: newId("request"),
        threadId,
        turnId: state.turn?.id ?? null,
        kind: "subtask",
        title: `Sub-tarea: ${title}`.slice(0, 300),
        body: [
          reason?.trim(),
          `Agente: ${agent.engine}${agent.model ? ` (${agent.model})` : ""}. Parte del último commit de ${thread.repo.branch}.`,
          "",
          prompt.length > 4000 ? `${prompt.slice(0, 4000)}…` : prompt,
        ]
          .filter((line) => line !== undefined)
          .join("\n")
          .slice(0, 20_000),
        subtask: { title, prompt, agent },
        status: "open",
        answer: null,
        origin: null,
        createdAt: now(),
        answeredAt: null,
      };
      store.setMeta(threadId, {
        agentRequests: [...agentRequestIds(threadId), request.id],
      });
      append(threadId, [
        { type: "request.opened", threadId, at: now(), request },
      ]);
      state.turn?.mapper?.requestItem(request.id);
      if (!state.turn) setStatus(threadId, "waiting-user");
      return store.getRequest(request.id) as UserRequest;
    },

    /**
     * The owner's answer to a subtask request. Approving creates the child
     * thread from the parent's branch; the service may choose its id and
     * credential, as for any thread.
     */
    async answerSubtask(
      threadId: string,
      requestId: string,
      input: unknown,
    ): Promise<UserRequest> {
      const { childId, capabilityToken, ...rest } = (input ?? {}) as Record<
        string,
        unknown
      >;
      const parsed = AnswerRequest.safeParse({
        ...rest,
        type: "AnswerRequest",
        threadId,
        requestId,
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const request = store.getRequest(requestId);
      if (!request || request.threadId !== threadId || !request.subtask)
        throw new EngineError("not-found", "Solicitud no encontrada.");
      if (request.status !== "open" || answeringSubtasks.has(requestId))
        throw new EngineError("conflict", "Esa sub-tarea ya se respondió.");
      if (parsed.data.answer.approved === undefined)
        throw new EngineError("invalid", "Aprueba o rechaza la sub-tarea.");
      // Creating the child takes a while; a second click must not create
      // another one meanwhile.
      answeringSubtasks.add(requestId);
      try {
        return await settleSubtask(
          threadId,
          requestId,
          request as UserRequest & {
            subtask: NonNullable<UserRequest["subtask"]>;
          },
          parsed.data,
          childId,
          capabilityToken,
        );
      } finally {
        answeringSubtasks.delete(requestId);
      }
    },

    /** thread_subtask_status: the parent's children and where they stand. */
    async subtasks(threadId: string) {
      requireThread(threadId);
      const children = store.listThreads({
        parentId: threadId,
        includeArchived: true,
      });
      return Promise.all(
        children.map(async (child) => {
          const items = store.snapshot(child.id)?.items ?? [];
          const last = items.findLast(
            (item) => item.kind === "assistant_message",
          );
          const diff = await engine.diff(child.id).catch(() => []);
          return {
            id: child.id,
            title: child.title,
            status: child.status,
            busy: Boolean(lives.get(child.id)?.turn),
            branch: child.repo?.branch ?? null,
            agent: child.agent,
            closeMode: child.closeMode,
            lastMessage:
              last && "text" in last ? String(last.text).slice(-2000) : null,
            diffstat: diff.map(({ path, additions, deletions }) => ({
              path,
              additions,
              deletions,
            })),
          };
        }),
      );
    },

    /** thread_integrate_subtask: merges a finished child into its parent. */
    async integrateSubtask(threadId: string, childId: string) {
      const parent = requireThread(threadId);
      const child = store.getThread(childId);
      if (!child || child.parentId !== threadId)
        throw new EngineError("not-found", "Sub-tarea no encontrada.");
      if (!parent.repo || child.repo?.baseBranch !== parent.repo.branch)
        throw new EngineError(
          "invalid",
          "La sub-tarea no parte de la rama de este thread.",
        );
      if (lives.get(childId)?.turn || child.status === "setting-up")
        throw new EngineError(
          "invalid-state",
          "La sub-tarea sigue trabajando; espera a que termine su turno.",
        );
      const thread = await engine.close(childId, {
        mode: "merge",
        title: commitTitle(child.title, "sub-tarea"),
      });
      appendItem(threadId, null, {
        kind: "notice",
        level: "info",
        code: "subtask-integrated",
        text: `Sub-tarea «${child.title}» integrada en ${parent.repo.branch}.`,
      });
      return { integrated: true, thread };
    },

    /** thread_report_review: the verdict of the review stage's turn. */
    reportReview(threadId: string, input: unknown) {
      const parsed = AgentReview.safeParse(input);
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const thread = requireThread(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      const state = live(threadId);
      const turnId = state.turn?.id;
      if (!turnId)
        throw new EngineError(
          "invalid-state",
          "La revisión solo se reporta durante tu turno.",
        );
      if (!isReviewStage(thread))
        throw new EngineError(
          "invalid",
          "Solo la etapa de revisión reporta revisiones.",
        );
      if (state.review?.turnId === turnId)
        throw new EngineError(
          "conflict",
          "Ya reportaste la revisión de este turno.",
        );
      // `round` numbers the reviews; the limit counts only the times the
      // reviewer sent the work back.
      const round =
        (store.snapshot(threadId)?.items ?? []).filter(
          (item) => item.kind === "review",
        ).length + 1;
      if (parsed.data.verdict === "changes-requested")
        update(threadId, {
          counters: {
            ...thread.counters,
            reviewRounds: thread.counters.reviewRounds + 1,
          },
        });
      appendItem(threadId, turnId, {
        kind: "review",
        reviewId: newId("review"),
        round,
        ...parsed.data,
      });
      state.review = { ...parsed.data, turnId, round };
      return {
        recorded: true,
        round,
        maxRounds: thread.limits.maxReviewRounds,
        message:
          parsed.data.verdict === "changes-requested"
            ? "Revisión registrada; al terminar tu turno el thread vuelve a implementación (o al dueño si se acabaron las rondas). Termina tu respuesta ahora."
            : "Revisión registrada. Termina tu respuesta ahora.",
      };
    },

    /** thread_handoff: recorded now, applied when the agent's turn ends. */
    handoff(threadId: string, input: unknown) {
      const parsed = AgentHandoff.safeParse(input);
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const thread = requireThread(threadId);
      if (BUSY_STATUSES.has(thread.status))
        throw new EngineError("invalid-state", "El thread ya está cerrado.");
      const state = live(threadId);
      if (!state.turn?.id)
        throw new EngineError(
          "invalid-state",
          "El traspaso solo se pide durante tu turno.",
        );
      const target = resolveHandoff(thread, parsed.data.toStage);
      if ("error" in target) throw new EngineError("invalid", target.error);
      state.handoff = {
        turnId: state.turn.id,
        index: target.index,
        narrative: parsed.data.narrative,
        openItems: parsed.data.openItems,
      };
      const stage = thread.flow?.stages[target.index];
      return {
        accepted: true,
        toStage: parsed.data.toStage,
        message: `Traspaso a «${stage?.name}» registrado; ocurre al terminar tu turno. Termina tu respuesta ahora.`,
      };
    },

    request(threadId: string, requestId: string): UserRequest {
      const request = store.getRequest(requestId);
      if (!request || request.threadId !== threadId)
        throw new EngineError("not-found", "Solicitud no encontrada.");
      return request;
    },

    snapshot(threadId: string): ThreadSnapshot | null {
      const snap = store.snapshot(threadId);
      if (!snap) return null;
      const liveItems = engine.liveItems(threadId);
      if (!liveItems.length) return snap;
      const byId = new Map(liveItems.map((i) => [i.id, i]));
      return {
        ...snap,
        items: snap.items.map((item) => byId.get(item.id) ?? item),
      };
    },

    liveItems(threadId: string): Item[] {
      return lives.get(threadId)?.turn?.mapper?.liveItems() ?? [];
    },

    async diff(threadId: string): Promise<FileDiff[]> {
      const thread = requireThread(threadId);
      const base = store.meta(threadId).baseCommit;
      // A closed thread may have no worktree left: nothing to show.
      if (!thread.repo || !base || !existsSync(thread.repo.worktree)) return [];
      const current = await snapshotTree(git, thread.repo.worktree);
      return diffTrees(git, thread.repo.worktree, base, current);
    },

    async turnDiff(threadId: string, turnId: string): Promise<FileDiff[]> {
      const thread = requireThread(threadId);
      const checkpoint = store.checkpoint(turnId);
      if (!checkpoint || checkpoint.threadId !== threadId)
        throw new EngineError("not-found", "Turno no encontrado.");
      if (
        !thread.repo ||
        !checkpoint.beforeTree ||
        (!checkpoint.afterTree && !existsSync(thread.repo.worktree))
      )
        return [];
      const after =
        checkpoint.afterTree ?? (await snapshotTree(git, thread.repo.worktree));
      return diffTrees(git, thread.repo.worktree, checkpoint.beforeTree, after);
    },

    subscribeDeltas(listener: DeltaListener) {
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
    },

    /** After a restart nothing is running: settle what the log left open. */
    recover() {
      for (const thread of store.listThreads({
        includeArchived: false,
        limit: 1000,
      })) {
        const agentAsks = agentRequestIds(thread.id);
        for (const request of store.requests(thread.id))
          if (request.status === "open" && !agentAsks.has(request.id))
            append(thread.id, [
              {
                type: "request.resolved",
                threadId: thread.id,
                at: now(),
                requestId: request.id,
                status: "expired",
                answer: null,
                origin: null,
              },
            ]);
        for (const turn of store.turns(thread.id))
          if (turn.completedSeq === null)
            append(thread.id, [
              {
                type: "turn.completed",
                threadId: thread.id,
                at: now(),
                turnId: turn.id,
                outcome: "failed",
                error: "El lanzador se reinició durante el turno.",
              },
            ]);
        if (
          ["running", "setting-up", "waiting-user", "closing"].includes(
            thread.status,
          )
        ) {
          appendItem(thread.id, null, {
            kind: "notice",
            level: "warning",
            code: "restarted",
            text: "El lanzador se reinició; el turno se interrumpió.",
          });
          update(thread.id, {
            status: hasOpenRequests(thread.id) ? "waiting-user" : "idle",
          });
        }
      }
    },

    async shutdown() {
      for (const [threadId, state] of lives)
        if (state.turn) engine.interrupt(threadId);
      closed = true;
      for (const state of lives.values()) {
        if (state.idleTimer) clearTimeout(state.idleTimer);
        const controller = state.controller?.instance;
        state.controller = null;
        await controller?.shutdown("Lanzador detenido").catch(() => undefined);
      }
    },

    /** Waits until the thread has no running turn nor queued messages (tests). */
    async idle(threadId: string) {
      const state = live(threadId);
      while (state.loop || state.turn || state.queue.length) {
        await (state.loop ?? new Promise((r) => setTimeout(r, 10)));
      }
    },
  };
  return engine;
}

export type ThreadEngine = ReturnType<typeof createThreadEngine>;
