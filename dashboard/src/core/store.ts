import { subscribeChanges } from "./events";
import Dexie, { type Table } from "dexie";
import { newItem, uid, type Item, type Kind } from "./model";
export interface Pending {
  id: string;
  mutationId: string;
  baseVersion: number | string;
  entity: Item;
  error?: string;
  server?: Item;
}
class BrainDB extends Dexie {
  items!: Table<Item, string>;
  outbox!: Table<Pending, string>;
  meta!: Table<{ key: string; value: string }, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      items: "id,kind,projectId,date",
      outbox: "id",
      meta: "key",
    });
  }
}
/** A static demo build (VITE_DEMO=1, e.g. GitHub Pages) has no backend at all. */
export const isStaticDemo = import.meta.env.VITE_DEMO === "1";
export const isDemo =
  isStaticDemo ||
  new URLSearchParams(location.search).has("demo") ||
  sessionStorage.getItem("sb-demo") === "true";
export const db = new BrainDB(
  isDemo ? "second-brain-demo-v1" : "second-brain-private-v1",
);
let csrf = "";
let itemsTag = "";
export let authEnabled = false;
export function setAuthEnabled(value: boolean) {
  authEnabled = value;
}
/** Owner display name from the server (SB_OWNER_NAME); empty stays neutral. */
export let ownerName = "";
const ownerListeners = new Set<() => void>();
export function setOwnerName(value: unknown) {
  const next = typeof value === "string" ? value.trim().slice(0, 60) : "";
  if (next === ownerName) return;
  ownerName = next;
  ownerListeners.forEach((listener) => listener());
}
export function onOwnerNameChange(listener: () => void) {
  ownerListeners.add(listener);
  return () => void ownerListeners.delete(listener);
}
export function resetCsrf() {
  csrf = "";
}
const expiredListeners = new Set<() => void>();
/** The server rejected the session cookie: the app asks for the password again. */
export const onSessionExpired = (listener: () => void) => {
  expiredListeners.add(listener);
  return () => {
    expiredListeners.delete(listener);
  };
};
let syncing = false;
let syncPending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
let snapshot: {
  items: Item[];
  pending: Pending[];
  syncing: boolean;
  error: string;
  ready: boolean;
} = { items: [], pending: [], syncing: false, error: "", ready: false };
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getSnapshot = () => snapshot;
async function refresh() {
  snapshot = {
    ...snapshot,
    items: await db.items.toArray(),
    pending: await db.outbox.toArray(),
    syncing,
    ready: true,
  };
  listeners.forEach((x) => x());
}
function setError(error: string) {
  snapshot = { ...snapshot, error };
  listeners.forEach((x) => x());
}
const TIMEOUT_MS = 30_000;
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  renewed = false,
): Promise<T> {
  const write = Boolean(options.method && options.method !== "GET");
  if (!csrf && write) {
    const r = await fetch("/api/v1/auth/csrf");
    if (!r.ok) throw new Error("No se pudo verificar la sesión.");
    csrf = (await r.json()).token;
  }
  const conditional =
    path === "/items" && itemsTag && (await db.items.count()) > 0;
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": csrf,
        ...(conditional ? { "If-None-Match": itemsTag } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError")
      throw new Error(
        write
          ? "El servidor no respondió a tiempo. El cambio pudo guardarse: revisa antes de repetirlo."
          : "El servidor no respondió a tiempo.",
      );
    throw error;
  }
  if (path === "/items" && response.status === 304) return null as T;
  if (path === "/items" && response.ok)
    itemsTag = response.headers.get("etag") || "";
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    // The server checks the token before doing anything, so sending again is safe.
    if (data.code === "csrf" && write && !renewed) {
      csrf = "";
      return api<T>(path, options, true);
    }
    if (response.status === 401 && !path.startsWith("/auth/")) {
      csrf = "";
      expiredListeners.forEach((listener) => listener());
    }
    const error = new Error(
      data.error ||
        data.detail ||
        // A reverse proxy answers 413 with HTML, before reaching the service.
        (response.status === 413
          ? "El proxy del servidor rechazó el envío por su tamaño."
          : "No se pudo completar la operación."),
    );
    Object.assign(error, {
      status: response.status,
      server: data.server,
      recibo: data.recibo,
    });
    throw error;
  }
  return response.status === 204 ? (null as T) : response.json();
}
let initialization: Promise<void> | null = null;
export function init() {
  return (initialization ||= initialize());
}
async function initialize() {
  if (isDemo) {
    sessionStorage.setItem("sb-demo", "true");
    if (!(await db.meta.get("seeded"))) {
      await db.items.bulkPut((await import("./demo")).demoData());
      await db.meta.put({ key: "seeded", value: "true" });
    }
  }
  await refresh();
  if (!isDemo) {
    setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, 15000);
    window.addEventListener("online", () => void sync());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void sync();
    });
    await sync();
    subscribeChanges(() => void sync());
  }
}
export async function save(entity: Item) {
  entity = { ...entity, updatedAt: new Date().toISOString() };
  if (entity.kind === "notification" && !isDemo) {
    const prior = JSON.parse(
      (await db.meta.get("read-notices"))?.value || "[]",
    ) as string[];
    await db.meta.put({
      key: "read-notices",
      value: JSON.stringify([...new Set([...prior, entity.id])]),
    });
    await db.items.put(entity);
    await refresh();
    return entity;
  }
  if (entity.kind === "transaction" && !isDemo) {
    if (!navigator.onLine)
      throw new Error(
        "Los movimientos se confirman con conexión. Guarda la información como idea sin ordenar en Tareas para revisarla después.",
      );
    const saved = await api<Item>("/mutations", {
      method: "POST",
      body: JSON.stringify({
        mutationId: uid(),
        baseVersion: entity.version,
        entity,
      }),
    });
    await db.items.put(saved);
    await refresh();
    return saved as Item;
  }
  await db.transaction("rw", db.items, db.outbox, async () => {
    const prior = await db.outbox.get(entity.id);
    await db.items.put(entity);
    if (!isDemo)
      await db.outbox.put({
        id: entity.id,
        mutationId: uid(),
        baseVersion: prior?.baseVersion ?? entity.version,
        entity,
        error: prior?.error,
        server: prior?.server,
      });
  });
  await refresh();
  if (!isDemo) {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), 300);
  }
  return entity;
}
export const create = (kind: Kind, data: Partial<Item>) =>
  save(newItem(kind, data));
export const remove = (item: Item) => save({ ...item, deleted: true });
export async function sync() {
  if (isDemo || !navigator.onLine) return;
  if (syncing) {
    // Re-run once when the current pass ends, so a save made meanwhile is not left waiting for the next cycle.
    syncPending = true;
    return;
  }
  syncing = true;
  await refresh();
  // One failing draft must not stop the others, and the download runs regardless.
  let failure = "";
  try {
    for (const p of await db.outbox.toArray()) {
      if (p.error) continue;
      try {
        const saved = await api<Item>("/mutations", {
          method: "POST",
          body: JSON.stringify(p),
        });
        await db.transaction("rw", db.items, db.outbox, async () => {
          const current = await db.outbox.get(p.id);
          if (current?.mutationId === p.mutationId) {
            await db.outbox.delete(p.id);
            await db.items.put(saved);
          } else if (current) {
            await db.outbox.put({
              ...current,
              baseVersion: saved.version,
              entity: { ...current.entity, version: saved.version },
            });
          }
        });
      } catch (error) {
        const e = error as Error & { status?: number; server?: Item };
        if (e.status === 409 || e.status === 400) {
          // Rejected for good: keep it for review, unless it was edited meanwhile.
          await db.transaction("rw", db.outbox, async () => {
            const current = await db.outbox.get(p.id);
            if (current?.mutationId === p.mutationId)
              await db.outbox.put({
                ...current,
                error: e.message,
                server: e.server,
              });
          });
        } else {
          failure ||= e.message;
          // Offline or signed out: the remaining drafts would fail the same way.
          if (e.status === undefined || e.status === 401) break;
        }
      }
    }
  } catch (e) {
    failure ||= (e as Error).message;
  }
  try {
    const remote = await api<Item[] | null>("/items");
    if (remote !== null) {
      const pending = new Set((await db.outbox.toArray()).map((p) => p.id));
      const readNotices = new Set(
        JSON.parse((await db.meta.get("read-notices"))?.value || "[]"),
      );
      await db.transaction("rw", db.items, async () => {
        const live = new Set(remote.map((x) => x.id));
        const stale = (await db.items.toArray()).filter(
          (x) => !live.has(x.id) && !pending.has(x.id),
        );
        await db.items.bulkDelete(stale.map((x) => x.id));
        await db.items.bulkPut(
          remote
            .filter((x) => !pending.has(x.id))
            .map((x) =>
              x.kind === "notification" && readNotices.has(x.id)
                ? { ...x, status: "read" }
                : x,
            ),
        );
      });
    }
    await db.meta.put({ key: "lastSync", value: new Date().toISOString() });
  } catch (e) {
    failure ||= (e as Error).message;
  } finally {
    setError(failure);
    syncing = false;
    await refresh();
    if (syncPending) {
      syncPending = false;
      void sync();
    }
  }
}
export async function resolve(id: string, mode: "server" | "copy") {
  const p = await db.outbox.get(id);
  if (!p) return;
  if (mode === "copy") {
    if (p.entity.kind === "transaction")
      throw new Error(
        "Los movimientos financieros se corrigen mediante reversión.",
      );
    await save({
      ...p.entity,
      id: uid(),
      version: 0,
      title: p.entity.title + " (copia local)",
    });
  }
  if (p.server) await db.items.put(p.server);
  else await db.items.delete(id);
  await db.outbox.delete(id);
  await refresh();
  await sync();
}
export async function resetDemo() {
  await db.items.clear();
  await db.items.bulkPut((await import("./demo")).demoData());
  await refresh();
}
export async function importItems(items: Item[]) {
  if (isDemo) {
    await db.items.bulkPut(items);
    await refresh();
    return;
  }
  await api("/imports", { method: "POST", body: JSON.stringify({ items }) });
  await sync();
}
export async function canLogout() {
  return (await db.outbox.count()) === 0;
}
export async function logout() {
  if (!(await canLogout()))
    throw new Error(
      "Sincroniza o exporta los cambios pendientes antes de salir.",
    );
  await api("/auth/logout", { method: "POST" });
  await db.items.clear();
  await db.meta.clear();
  csrf = "";
  location.reload();
}
