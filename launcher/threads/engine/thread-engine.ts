// The thread engine: commands in, events out. Owns the live state of each
// thread (running turn, queued messages, provider controller, open provider
// requests) and writes every change to the event store.
import {
  AnswerRequest,
  CreateThread,
  SendMessage,
  TERMINAL_STATUSES,
  newId,
  type AgentRef,
  type Attachment,
  type DeliveryMode,
  type FileDiff,
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
  defaultMaxTurns?: number;
}

export type EngineErrorCode =
  "not-found" | "invalid-state" | "conflict" | "invalid";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.code = code;
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
}

interface Live {
  turn: RunningTurn | null;
  queue: QueuedMessage[];
  controller: { instance: ProviderController; signature: string } | null;
  idleTimer: NodeJS.Timeout | null;
  pending: Map<string, PendingRequest>;
  lastSeq: number;
  loop: Promise<void> | null;
}

export type DeltaListener = (message: StreamMessage) => void;

const BUSY_STATUSES = new Set(["closing", ...TERMINAL_STATUSES]);

export function createThreadEngine(deps: EngineDeps) {
  const {
    store,
    workspaces,
    scheduler,
    git,
    context,
    controllers,
    now = () => new Date().toISOString(),
    idleControllerMs = 10 * 60_000,
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
        controller: null,
        idleTimer: null,
        pending: new Map(),
        lastSeq: store.lastSeq(threadId),
        loop: null,
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
      readOnly: thread.autonomy === "read-only",
    });

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
      turn.mapper?.notice(
        "info",
        accept ? "auto-approved" : "auto-declined",
        `${accept ? "Aprobado" : "Rechazado"} automáticamente: ${ask.title ?? "acción"}`,
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

  const finishStatus = (threadId: string) => {
    const thread = requireThread(threadId);
    if (BUSY_STATUSES.has(thread.status)) return;
    setStatus(
      threadId,
      thread.counters.turns >= thread.limits.maxTurns
        ? "needs-decision"
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
    const mapper = createEventMapper({
      threadId,
      turnId,
      agent,
      now,
      newItemId: () => newId("item"),
      sink: {
        persist: (event) => append(threadId, [event])[0] as ThreadEvent,
        delta: (itemId, field, delta) =>
          publishDelta({
            type: "item.delta",
            threadId,
            itemId,
            field,
            delta,
            afterSeq: state.lastSeq,
          }),
      },
      onRateLimits: (windows) =>
        store.recordUsage({
          engine: agent.engine,
          at: now(),
          source: "provider-event",
          windows,
        }),
    });
    turn.mapper = mapper;
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
        readOnly: thread.autonomy === "read-only",
      });
      const controller = await controllerFor(threadId, thread, agent);
      if (turn.abort.signal.aborted) throw new Error("Interrumpido");
      const nativeIds = store.meta(threadId).nativeIds ?? {};
      let sequence = 0;
      const ctx: Record<string, unknown> = {
        ...base,
        session: {
          ...(base.session as Record<string, unknown>),
          conversacionId: nativeIds[agent.engine] ?? null,
        },
        turnId,
        prompt: message.text,
        attachments: message.attachments,
        nextId: () => ++sequence,
        onAbort: (fn: () => void) => turn.aborters.push(fn),
        onControl: (next: Partial<Control>) => {
          turn.control = { ...turn.control, ...next };
        },
        invalidateConnection: () => undefined,
        nativeId: (id: string) => {
          if (nativeIds[agent.engine] === id) return;
          nativeIds[agent.engine] = id;
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
    finishStatus(threadId);
    scheduleIdleShutdown(threadId);
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

  const engine = {
    async create(input: unknown): Promise<Thread> {
      const parsed = CreateThread.safeParse({
        ...(input as object),
        type: "CreateThread",
      });
      if (!parsed.success)
        throw new EngineError(
          "invalid",
          parsed.error.issues[0]?.message ?? "Datos inválidos.",
        );
      const command = parsed.data;
      const id = newId("thread");
      const title = (
        command.title ??
        command.prompt.split("\n").find((l) => l.trim()) ??
        "Thread"
      )
        .trim()
        .slice(0, 80);
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
      const at = now();
      const thread: Thread = {
        id,
        title,
        kind: command.kind,
        status: command.kind === "repo" ? "setting-up" : "idle",
        autonomy: command.autonomy,
        agent: command.agent,
        repo,
        workspace,
        parentId: command.parentId ?? null,
        flow: null,
        stageIndex: 0,
        counters: { turns: 0, reviewRounds: 0, subtasks: 0 },
        limits: { maxTurns: defaultMaxTurns, maxReviewRounds: 3 },
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
        state.queue.push({ text, attachments, ...(agent ? { agent } : {}) });
        if (thread.status === "needs-decision")
          update(threadId, {
            status: "idle",
            limits: {
              ...thread.limits,
              maxTurns: thread.counters.turns + defaultMaxTurns,
            },
          });
        void kick(threadId);
      }
      return { item, delivery };
    },

    interrupt(threadId: string) {
      requireThread(threadId);
      const state = live(threadId);
      state.queue.length = 0;
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
      const state = live(threadId);
      const pending = state.pending.get(requestId);
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
      if (!thread.repo || !base) return [];
      const current = await snapshotTree(git, thread.repo.worktree);
      return diffTrees(git, thread.repo.worktree, base, current);
    },

    async turnDiff(threadId: string, turnId: string): Promise<FileDiff[]> {
      const thread = requireThread(threadId);
      const checkpoint = store.checkpoint(turnId);
      if (!checkpoint || checkpoint.threadId !== threadId)
        throw new EngineError("not-found", "Turno no encontrado.");
      if (!thread.repo || !checkpoint.beforeTree) return [];
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
        for (const request of store.requests(thread.id))
          if (request.status === "open")
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
          update(thread.id, { status: "idle" });
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
