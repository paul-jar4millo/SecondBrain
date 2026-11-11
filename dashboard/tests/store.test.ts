import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { search: "" });
vi.stubGlobal("window", { addEventListener: () => {} });
vi.stubGlobal("document", { addEventListener: () => {} });
vi.stubGlobal("navigator", { onLine: true });
const { db, save, sync, onSessionExpired } = await import("../src/core/store");
const { newItem } = await import("../src/core/model");
let remote: ReturnType<typeof newItem>[] = [];
let posts = 0;
let fail = false;
let conflict = false;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await db.items.clear();
  await db.outbox.clear();
  remote = [];
  posts = 0;
  fail = false;
  conflict = false;
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (fail) throw new Error("network unavailable");
      if (path.endsWith("/auth/csrf"))
        return new Response(JSON.stringify({ token: "test" }));
      if (path.endsWith("/items")) return new Response(JSON.stringify(remote));
      if (options?.method === "POST") {
        posts++;
        const body = JSON.parse(String(options.body));
        if (conflict)
          return new Response(
            JSON.stringify({
              error: "changed remotely",
              server: { ...body.entity, body: "remote text", version: 3 },
            }),
            { status: 409 },
          );
        const entity = { ...body.entity, version: body.baseVersion + 1 };
        remote = [...remote.filter((x) => x.id !== entity.id), entity];
        return new Response(JSON.stringify(entity));
      }
      throw new Error("unexpected request");
    }),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("offline outbox", () => {
  it("keeps its local snapshot on an unchanged 304 and sends the ETag", async () => {
    const record = newItem("task", { title: "Cached" });
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path, options) => {
        count++;
        if (count === 1)
          return new Response(JSON.stringify([record]), {
            headers: { ETag: '"snapshot"' },
          });
        expect(options.headers["If-None-Match"]).toBe('"snapshot"');
        return new Response(null, { status: 304 });
      }),
    );
    await sync();
    await sync();
    expect(await db.items.get(record.id)).toMatchObject({ title: "Cached" });
    expect((await import("../src/core/store")).getSnapshot().error).toBe("");
  });
  it("sends a save made during a running sync without waiting for the 15 s cycle", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        if (path.endsWith("/items") && !options?.method) await gate;
        return base(path, options);
      }),
    );
    const running = sync();
    await vi.advanceTimersByTimeAsync(0);
    await save(newItem("task", { title: "Saved mid-sync" }));
    // The debounce timer fires while the first pass is still running.
    await vi.advanceTimersByTimeAsync(300);
    expect(posts).toBe(0);
    release();
    await running;
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(posts).toBe(1));
  });
  it("persists capture without a network and sends it once after reconnecting", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const item = newItem("inbox", { title: "Idea offline" });
    await save(item);
    expect(await db.items.get(item.id)).toMatchObject({
      title: "Idea offline",
    });
    expect(await db.outbox.count()).toBe(1);
    expect(posts).toBe(0);
    vi.stubGlobal("navigator", { onLine: true });
    await sync();
    expect(posts).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    await sync();
    expect(posts).toBe(1);
  });
  it("collapses consecutive local changes while keeping the original base version", async () => {
    const item = newItem("note", { title: "Draft", version: 2, body: "first" });
    await save(item);
    await save({ ...item, body: "second" });
    const queued = await db.outbox.get(item.id);
    expect(queued?.baseVersion).toBe(2);
    expect(queued?.entity.body).toBe("second");
    await sync();
    expect(posts).toBe(1);
    expect((await db.items.get(item.id))?.body).toBe("second");
  });
  it("retains outbox and text on a failed network request", async () => {
    const item = newItem("note", {
      title: "Private note",
      body: "must survive",
    });
    await save(item);
    fail = true;
    await sync();
    expect(await db.outbox.count()).toBe(1);
    expect((await db.items.get(item.id))?.body).toBe("must survive");
    fail = false;
    await sync();
    expect(await db.outbox.count()).toBe(0);
  });
  it("keeps both versions of a conflicting note", async () => {
    const item = newItem("note", {
      title: "Conflict",
      body: "local text",
      version: 1,
    });
    await save(item);
    conflict = true;
    await sync();
    const pending = await db.outbox.get(item.id);
    expect(pending?.error).toBe("changed remotely");
    expect(pending?.entity.body).toBe("local text");
    expect(pending?.server?.body).toBe("remote text");
    expect((await db.items.get(item.id))?.body).toBe("local text");
  });
  it("does not post financial entries offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(
      save(newItem("transaction", { title: "Offline expense" })),
    ).rejects.toThrow("conexión");
    expect(await db.items.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

it("reconciles external vault removals and preserves pending offline work", async () => {
  const removed = newItem("note", { title: "Removed in Obsidian" });
  const draft = newItem("note", { title: "Local pending" });
  await db.items.put(removed);
  await save(draft);
  fail = true;
  await sync();
  expect(await db.items.get(removed.id)).toBeDefined();
  fail = false;
  remote = [];
  conflict = true;
  await sync();
  expect(await db.items.get(removed.id)).toBeUndefined();
  expect(await db.items.get(draft.id)).toBeDefined();
  expect(await db.outbox.get(draft.id)).toBeDefined();
});

it("sends a file hash revision unchanged instead of treating it as a SQL version", async () => {
  const revision = "abcdef0123456789".repeat(4);
  const note = newItem("note", {
    title: "Vault note",
    version: revision,
    body: "changed",
  });
  await save(note);
  await sync();
  const calls = vi.mocked(fetch).mock.calls;
  const request = calls.find(([, options]) => options?.method === "POST");
  expect(JSON.parse(String(request?.[1]?.body)).baseVersion).toBe(revision);
});

describe("sync failures", () => {
  it("renews an expired security token and sends the draft instead of marking a conflict", async () => {
    let tokens = 0;
    let rejected = false;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, options) => {
      if (String(path).endsWith("/auth/csrf"))
        return new Response(JSON.stringify({ token: "t" + ++tokens }));
      const sent = (options?.headers as Record<string, string>)?.[
        "X-CSRF-TOKEN"
      ];
      if (options?.method === "POST" && (!rejected || sent !== "t" + tokens)) {
        rejected = true;
        return new Response(
          JSON.stringify({
            error: "La sesión de seguridad cambió.",
            code: "csrf",
          }),
          { status: 400 },
        );
      }
      return base(path as string, options);
    });
    const item = newItem("note", { title: "Token caducado" });
    await save(item);
    await sync();
    expect(await db.outbox.get(item.id)).toBeUndefined();
    expect(posts).toBe(1);
  });
  it("keeps sending other drafts and refreshing when one draft fails on the server", async () => {
    const broken = newItem("note", { title: "Rompe" });
    const fine = newItem("note", { title: "Bien" });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, options) => {
      if (
        options?.method === "POST" &&
        String(options.body).includes(broken.id)
      )
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      return base(path as string, options);
    });
    const other = newItem("note", { title: "Del servidor" });
    remote = [other];
    await save(broken);
    await save(fine);
    await sync();
    expect(await db.outbox.get(fine.id)).toBeUndefined();
    const pending = await db.outbox.get(broken.id);
    expect(pending).toBeDefined();
    expect(pending?.error).toBeUndefined();
    expect(await db.items.get(other.id)).toBeDefined();
  });
  it("does not overwrite an edit saved while a rejected send was in flight", async () => {
    const item = newItem("note", { title: "Original", body: "v1" });
    await save(item);
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, options) => {
      if (options?.method === "POST") {
        await save({ ...item, body: "v2" });
        return new Response(JSON.stringify({ error: "changed remotely" }), {
          status: 409,
        });
      }
      return base(path as string, options);
    });
    await sync();
    const pending = await db.outbox.get(item.id);
    expect(pending?.entity.body).toBe("v2");
    expect(pending?.error).toBeUndefined();
  });
});

it("announces an expired session so the app can ask for the password again", async () => {
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (path, options) =>
    String(path).endsWith("/items")
      ? new Response(JSON.stringify({ error: "Inicia sesión." }), {
          status: 401,
        })
      : base(path as string, options),
  );
  let expired = 0;
  const stop = onSessionExpired(() => expired++);
  await sync();
  stop();
  expect(expired).toBe(1);
});
