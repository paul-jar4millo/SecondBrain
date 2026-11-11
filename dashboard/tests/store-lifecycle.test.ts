import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";

it("no inicia sondeos al importar y los registra una sola vez desde init", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const online = vi.fn();
  const visibility = vi.fn();
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  vi.stubGlobal("window", { addEventListener: online });
  vi.stubGlobal("document", {
    addEventListener: visibility,
    visibilityState: "visible",
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", async () => new Response("[]"));
  const interval = vi.spyOn(globalThis, "setInterval");
  const { init, db } = await import("../src/core/store");
  try {
    expect(interval).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
    expect(visibility).not.toHaveBeenCalled();
    await init();
    await init();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(online.mock.calls[0][0]).toBe("online");
    expect(visibility).toHaveBeenCalledTimes(1);
    expect(visibility.mock.calls[0][0]).toBe("visibilitychange");
  } finally {
    db.close();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
