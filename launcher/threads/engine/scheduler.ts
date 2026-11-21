// Process slots for thread turns (SB_MAX_ACTIVE_TURNS). Waiting turns are served
// by priority — owner turns first, then reviews, then subtasks — and in
// arrival order within a priority.

export const PRIORITY = { user: 0, review: 1, subtask: 2 } as const;
export type Priority = keyof typeof PRIORITY;

export interface Slot {
  release(): void;
}

export interface Scheduler {
  /**
   * Resolves when a slot is free. `onWaiting` runs once when the turn has to
   * wait, so the thread can show "waiting for capacity".
   */
  acquire(
    threadId: string,
    priority: Priority,
    options?: { onWaiting?: () => void; signal?: AbortSignal },
  ): Promise<Slot>;
  readonly running: number;
  readonly waiting: number;
}

interface Waiter {
  threadId: string;
  rank: number;
  order: number;
  grant: (slot: Slot) => void;
  fail: (error: Error) => void;
}

export function createScheduler(capacity: number): Scheduler {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new Error("La capacidad debe ser un entero positivo.");
  let running = 0;
  let order = 0;
  const queue: Waiter[] = [];

  const slot = (): Slot => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        running--;
        next();
      },
    };
  };

  const next = () => {
    while (running < capacity && queue.length) {
      queue.sort((a, b) => a.rank - b.rank || a.order - b.order);
      const waiter = queue.shift() as Waiter;
      running++;
      waiter.grant(slot());
    }
  };

  return {
    acquire(threadId, priority, { onWaiting, signal } = {}) {
      if (signal?.aborted)
        return Promise.reject(new Error("Turno cancelado antes de empezar."));
      if (running < capacity && !queue.length) {
        running++;
        return Promise.resolve(slot());
      }
      return new Promise<Slot>((resolve, reject) => {
        const waiter: Waiter = {
          threadId,
          rank: PRIORITY[priority],
          order: order++,
          grant: resolve,
          fail: reject,
        };
        queue.push(waiter);
        onWaiting?.();
        signal?.addEventListener(
          "abort",
          () => {
            const index = queue.indexOf(waiter);
            if (index < 0) return;
            queue.splice(index, 1);
            waiter.fail(
              new Error("Turno cancelado mientras esperaba capacidad."),
            );
          },
          { once: true },
        );
      });
    },
    get running() {
      return running;
    },
    get waiting() {
      return queue.length;
    },
  };
}
