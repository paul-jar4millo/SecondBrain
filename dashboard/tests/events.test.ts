import { expect, it, vi } from "vitest";
import { subscribeChanges } from "../src/core/events";
it("shares one event stream, refreshes on reconnect and removes unsubscribed readers", () => {
  const sources: {
    onmessage?: () => void;
    onopen?: () => void;
    close(): void;
  }[] = [];
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal(
    "EventSource",
    class {
      constructor() {
        sources.push(this);
      }
      close() {}
    },
  );
  const seen: string[] = [];
  const first = subscribeChanges(() => seen.push("first"));
  const second = subscribeChanges(() => seen.push("second"));
  expect(sources).toHaveLength(1);
  sources[0].onmessage?.();
  expect(seen).toEqual(["first", "second"]);
  first();
  sources[0].onopen?.();
  expect(seen).toEqual(["first", "second", "second"]);
  second();
  vi.unstubAllGlobals();
});
