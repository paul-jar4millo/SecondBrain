import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

type Handler = (event: Record<string, unknown>) => void;

function worker(clients: Array<Record<string, unknown>>) {
  const handlers: Record<string, Handler> = {};
  const self = {
    addEventListener: (type: string, handler: Handler) =>
      (handlers[type] = handler),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async () => undefined),
    },
  };
  runInNewContext(readFileSync(join("public", "sw.js"), "utf8"), {
    self,
    location: new URL("https://app.example.org/"),
    caches: {},
    fetch: () => undefined,
    URL,
  });
  const run = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({
      ...event,
      waitUntil: (p: Promise<unknown>) => (pending = p),
    });
    await pending;
  };
  return { self, run };
}

it("a push shows the notice and keeps only a local link", async () => {
  const { self, run } = worker([]);
  await run("push", {
    data: {
      json: () => ({
        title: "Slug",
        body: "Listo para revisar",
        url: "https://evil.example/x",
        tag: "thr_abc1234567",
      }),
    },
  });
  expect(self.registration.showNotification).toHaveBeenCalledWith(
    "Slug",
    expect.objectContaining({
      body: "Listo para revisar",
      tag: "thr_abc1234567",
      data: { url: "/threads" },
    }),
  );
});

it("a click focuses an open app window and goes to the thread", async () => {
  const navigate = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  const { self, run } = worker([
    { url: "https://other.example/", focus, navigate },
    { url: "https://app.example.org/tasks", focus, navigate },
  ]);
  const close = vi.fn();
  await run("notificationclick", {
    notification: { close, data: { url: "/threads/thr_abc1234567" } },
  });
  expect(close).toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith(
    "https://app.example.org/threads/thr_abc1234567",
  );
  expect(self.clients.openWindow).not.toHaveBeenCalled();
});

it("a link to another origin falls back to Threads", async () => {
  const { self, run } = worker([]);
  await run("notificationclick", {
    notification: { close: () => undefined, data: { url: "//evil.example/x" } },
  });
  expect(self.clients.openWindow).toHaveBeenCalledWith(
    "https://app.example.org/threads",
  );
});

it("without an open window a click opens one", async () => {
  const { self, run } = worker([]);
  await run("notificationclick", {
    notification: { close: () => undefined, data: { url: "/threads/x" } },
  });
  expect(self.clients.openWindow).toHaveBeenCalledWith(
    "https://app.example.org/threads/x",
  );
});
