// Mutable state shared by the execution modules: running jobs, terminals,
// per-session secrets and the resource queue.

/** @import { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process" */
/** @import { ToolProfile } from "../tool-catalog-types.d.ts" */
/** @import { ActiveJob, LiveTerminal, QueuedJob, ResourceQueueEntry } from "../types.d.ts" */

export function createExecutionState() {
  /** @type {Map<string, ActiveJob>} */
  const active = new Map();
  /** @type {Map<string, LiveTerminal>} */
  const terminales = new Map();
  /** @type {Map<string, ChildProcessWithoutNullStreams>} */
  const liveProcesses = new Map();
  /**
   * Processes that already emitted "exit" (exitCode alone misses signals).
   * @type {WeakSet<ChildProcess>}
   */
  const exitedProcesses = new WeakSet();
  /** @type {Map<string, NodeJS.Timeout>} */
  const idleTimers = new Map();
  /** @type {Map<string, string>} */
  const sessionTokenFiles = new Map();
  /** @type {Map<string, ToolProfile>} */
  const sessionProfiles = new Map();
  /** @type {Map<string, boolean>} */
  const sessionBillingGrants = new Map();
  /** @type {Map<string, () => Promise<unknown>>} */
  const materializedSkillCleanups = new Map();
  const materializedSkillsBySession = new Map();
  /** @type {ResourceQueueEntry[]} */
  const resourceQueue = [];
  /** @type {Map<string, QueuedJob>} */
  const queuedPromises = new Map();
  let nextEnqueueSeq = 1;
  /** Order of a job entering the resource queue. */
  const takeEnqueueSeq = () => nextEnqueueSeq++;
  /** @type {Promise<unknown>} */
  let cola = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
  function serial(fn) {
    const next = cola.then(fn);
    cola = next.catch(() => {});
    return next;
  }
  /**
   * Sessions whose next queued message is being started.
   * @type {Set<string>}
   */
  const draining = new Set();
  return {
    activos: active,
    terminales,
    liveProcesses,
    exitedProcesses,
    idleTimers,
    sessionTokenFiles,
    sessionProfiles,
    sessionBillingGrants,
    materializedSkillCleanups,
    materializedSkillsBySession,
    resourceQueue,
    queuedPromises,
    takeEnqueueSeq,
    serial,
    drenando: draining,
  };
}

/** @typedef {ReturnType<typeof createExecutionState>} ExecutionState */
