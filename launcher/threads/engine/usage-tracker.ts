// Plan limits seen in provider events (phase B5). Providers report one or
// more windows at a time; the tracker keeps the latest value of each and
// hands /usage the shape the dashboard already reads.
import type {
  Engine,
  RateLimitWindow,
  UsageSnapshot,
} from "../../../contracts/src/index.ts";
import type { Store } from "../store/event-log.ts";

/** Provider window names → the dashboard's windows. */
const WINDOW_IDS: Record<string, "5h" | "semanal"> = {
  five_hour: "5h",
  "300m": "5h",
  seven_day: "semanal",
  "10080m": "semanal",
};

/** A repeated reading is stored again only after this long. */
const REFRESH_MS = 5 * 60_000;

export interface LegacyUsage {
  ventanas: Partial<
    Record<
      "5h" | "semanal",
      { usado: number; reinicia: string | null; agotada: boolean }
    >
  >;
  actualizado: string | null;
}

export function toLegacyUsage(snapshot: UsageSnapshot): LegacyUsage | null {
  const ventanas: LegacyUsage["ventanas"] = {};
  for (const window of snapshot.windows) {
    const id = WINDOW_IDS[window.window];
    if (!id) continue;
    ventanas[id] = {
      usado: window.usedPercent,
      reinicia: window.resetsAt,
      agotada: window.usedPercent >= 100 || window.status === "rejected",
    };
  }
  return Object.keys(ventanas).length
    ? { ventanas, actualizado: snapshot.at }
    : null;
}

/**
 * Providers repeat the same reading on every event, sometimes with a reset
 * time a few seconds off; that is not a new reading.
 */
function sameReading(a: RateLimitWindow[], b: RateLimitWindow[]) {
  const key = (windows: RateLimitWindow[]) =>
    JSON.stringify(
      windows.map((w) => [
        w.window,
        w.usedPercent,
        w.status ?? null,
        w.resetsAt ? Math.round(Date.parse(w.resetsAt) / 600_000) : null,
      ]),
    );
  return key(a) === key(b);
}

export function createUsageTracker({
  store,
  now,
}: {
  store: Store;
  now: () => string;
}) {
  return {
    record(engine: Engine, windows: RateLimitWindow[]) {
      const previous = store.latestUsage(engine);
      const merged = new Map(
        (previous?.windows ?? []).map((w) => [w.window, w]),
      );
      for (const window of windows) merged.set(window.window, window);
      const next = [...merged.values()].sort((a, b) =>
        a.window.localeCompare(b.window),
      );
      const at = now();
      if (
        previous &&
        sameReading(previous.windows, next) &&
        Date.parse(at) - Date.parse(previous.at) < REFRESH_MS
      )
        return;
      store.recordUsage({
        engine,
        at,
        source: "provider-event",
        windows: next,
      });
    },

    latest(engine: Engine): LegacyUsage | null {
      const snapshot = store.latestUsage(engine);
      return snapshot ? toLegacyUsage(snapshot) : null;
    },
  };
}
