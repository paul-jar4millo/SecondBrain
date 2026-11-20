// Launcher HTTP routes for threads. The launcher listens on loopback and the
// caller (service) is already authorised; the service applies user policies.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ThreadStatus } from "../../../contracts/src/index.ts";
import type { Store } from "../store/event-log.ts";
import { EngineError, type ThreadEngine } from "../engine/thread-engine.ts";
import { streamGlobal, streamThread } from "./stream.ts";

const MAX_BODY = 1024 * 1024;
const ID = "(thr_[0-9A-Za-z_-]{6,64})";

const STATUS_BY_CODE: Record<string, number> = {
  "not-found": 404,
  invalid: 400,
  "invalid-state": 409,
  conflict: 409,
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY)
      throw new EngineError("invalid", "Cuerpo demasiado grande.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EngineError("invalid", "JSON inválido.");
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export function createThreadsHttp({
  engine,
  store,
}: {
  engine: ThreadEngine;
  store: Store;
}) {
  const routes: [
    string,
    RegExp,
    (
      m: RegExpExecArray,
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
    ) => Promise<void> | void,
  ][] = [
    [
      "GET",
      /^\/threads$/,
      (_m, _req, res, url) => {
        const statuses = (url.searchParams.get("status") ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => ThreadStatus.parse(s));
        const parent = url.searchParams.get("parent");
        send(res, 200, {
          threads: store.listThreads({
            ...(statuses.length ? { statuses } : {}),
            ...(parent !== null
              ? { parentId: parent === "none" ? null : parent }
              : {}),
            includeArchived: url.searchParams.get("archived") === "1",
          }),
        });
      },
    ],
    [
      "POST",
      /^\/threads$/,
      async (_m, req, res) => {
        send(res, 201, { thread: await engine.create(await readJson(req)) });
      },
    ],
    [
      "GET",
      /^\/threads\/stream$/,
      (_m, req, res, url) => streamGlobal(req, res, url, { store }),
    ],
    [
      "GET",
      /^\/inbox$/,
      (_m, _req, res) => send(res, 200, { entries: store.inbox() }),
    ],
    [
      "GET",
      new RegExp(`^/threads/${ID}$`),
      (m, _req, res) => {
        const snapshot = engine.snapshot(m[1] as string);
        if (!snapshot)
          throw new EngineError("not-found", "Thread no encontrado.");
        send(res, 200, snapshot);
      },
    ],
    [
      "GET",
      new RegExp(`^/threads/${ID}/stream$`),
      (m, req, res, url) => {
        if (!store.getThread(m[1] as string))
          throw new EngineError("not-found", "Thread no encontrado.");
        streamThread(req, res, url, m[1] as string, { store, engine });
      },
    ],
    [
      "POST",
      new RegExp(`^/threads/${ID}/messages$`),
      async (m, req, res) => {
        send(res, 202, await engine.send(m[1] as string, await readJson(req)));
      },
    ],
    [
      "POST",
      new RegExp(`^/threads/${ID}/interrupt$`),
      (m, _req, res) => {
        send(res, 200, { interrupted: engine.interrupt(m[1] as string) });
      },
    ],
    [
      "POST",
      new RegExp(`^/threads/${ID}/requests/(req_[0-9A-Za-z_-]{6,64})$`),
      async (m, req, res) => {
        send(res, 200, {
          request: engine.answer(
            m[1] as string,
            m[2] as string,
            await readJson(req),
          ),
        });
      },
    ],
    [
      "POST",
      new RegExp(`^/threads/${ID}/close$`),
      async (m, req, res) => {
        send(res, 200, {
          thread: await engine.close(m[1] as string, await readJson(req)),
        });
      },
    ],
    [
      "POST",
      new RegExp(`^/threads/${ID}/archive$`),
      async (m, _req, res) => {
        send(res, 200, { thread: await engine.archive(m[1] as string) });
      },
    ],
    [
      "GET",
      new RegExp(`^/threads/${ID}/diff$`),
      async (m, _req, res) => {
        send(res, 200, { files: await engine.diff(m[1] as string) });
      },
    ],
    [
      "GET",
      new RegExp(`^/threads/${ID}/turns/(trn_[0-9A-Za-z_-]{6,64})/diff$`),
      async (m, _req, res) => {
        send(res, 200, {
          files: await engine.turnDiff(m[1] as string, m[2] as string),
        });
      },
    ],
  ];

  /** Handles the request when it is a thread route; returns false otherwise. */
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!/^\/(threads|inbox)(\/|$)/.test(url.pathname)) return false;
    try {
      for (const [method, pattern, fn] of routes) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        if (req.method !== method) continue;
        await fn(match, req, res, url);
        return true;
      }
      send(res, 404, { error: "Ruta no encontrada." });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      if (error instanceof EngineError)
        send(res, STATUS_BY_CODE[error.code] ?? 400, {
          error: error.message,
          ...error.details,
        });
      else if ((error as { name?: string })?.name === "ZodError")
        send(res, 400, { error: "Parámetros inválidos." });
      else send(res, 500, { error: "Error interno del lanzador." });
    }
    return true;
  }

  return { handle };
}
